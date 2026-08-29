import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Shape of the prisma client stub handed out by the mocked PrismaClient class. */
interface ClientStub {
  $queryRaw: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
}

const { PrismaClientMock } = vi.hoisted(() => ({
  // Implementation is replaced per test with a constructible function (new PrismaClient()).
  PrismaClientMock: vi.fn(function clientCtor() {
    return { $queryRaw: vi.fn(), $disconnect: vi.fn() } as ClientStub;
  }),
}));

// Only the PrismaClient CLASS is mocked — everything else (Prisma.sql) comes
// from the real module; no query ever runs, so no actual database is needed.
vi.mock("@prisma/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prisma/client")>();
  return { ...actual, PrismaClient: PrismaClientMock };
});

import { SCHEDULER_ADVISORY_LOCK_KEY } from "@/server/services/scheduler";
import { buildSingleSessionDatabaseUrl, createSchedulerLockConnection } from "@/server/services/scheduler-lock-connection";

function lastClient(): ClientStub {
  const result = PrismaClientMock.mock.results.at(-1);
  if (!result) {
    throw new Error("no lock client was constructed");
  }
  return result.value as ClientStub;
}

function lastConstructorArg(): { datasourceUrl: string } {
  // The ctor stubs are parameterless, so calls are typed as empty tuples;
  // cast the registry instead of declaring an unused constructor parameter.
  const calls = PrismaClientMock.mock.calls as unknown as Array<[unknown]>;
  const arg = calls.at(-1)?.[0] as unknown;
  if (!arg || typeof arg !== "object" || !("datasourceUrl" in arg)) {
    throw new Error("PrismaClient was constructed without a datasourceUrl");
  }
  return arg as { datasourceUrl: string };
}

function renderedQuery(arg: unknown) {
  const { strings, values } = arg as { strings: string[]; values: unknown[] };
  return { sql: strings.join("?"), values };
}

describe("scheduler lock connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://scheduler:s3cret@db.local:5432/taskito?schema=public&pool_timeout=17";
    PrismaClientMock.mockImplementation(function clientFactory(): ClientStub {
      return {
        $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      };
    });
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
  });

  it("opens its own PrismaClient pinned to a single connection (never the shared pool)", () => {
    createSchedulerLockConnection();

    expect(PrismaClientMock).toHaveBeenCalledTimes(1);
    const { datasourceUrl } = lastConstructorArg();
    // The dedicated lock client is a SEPARATE PrismaClient with its own pool,
    // pinned to EXACTLY one connection so the lock query and the unlock always
    // run on the same physical Postgres session — and so the lock never
    // occupies a connection from the shared global pool the jobs use (finding 8).
    const url = new URL(datasourceUrl);
    expect(`${url.protocol}//${url.username}:${url.password}@${url.host}${url.pathname}`).toBe(
      "postgresql://scheduler:s3cret@db.local:5432/taskito",
    );
    expect(url.searchParams.get("connection_limit")).toBe("1");
    expect(url.searchParams.get("schema")).toBe("public");
  });

  it("pins the connection limit even when the base URL already carries one", () => {
    process.env.DATABASE_URL = "postgresql://scheduler:s3cret@db.local:5432/taskito?connection_limit=10";

    const url = new URL(buildSingleSessionDatabaseUrl(process.env.DATABASE_URL));

    expect(url.searchParams.get("connection_limit")).toBe("1");
  });

  it("rejects a DATABASE_URL that is not a URL instead of silently misconfiguring the lock session", () => {
    expect(() => buildSingleSessionDatabaseUrl("host=db.local user=scheduler")).toThrow(
      /DATABASE_URL is not a parsable URL/,
    );
  });

  it("throws early when DATABASE_URL is missing (scheduler treats it as a skip)", () => {
    delete process.env.DATABASE_URL;

    expect(() => createSchedulerLockConnection()).toThrow(/DATABASE_URL is not configured/);
    expect(PrismaClientMock).not.toHaveBeenCalled();
  });

  it("acquires with a SESSION-scoped pg_try_advisory_lock (never the _xact_ variant)", async () => {
    const connection = createSchedulerLockConnection();

    await expect(connection.tryAdvisoryLock(SCHEDULER_ADVISORY_LOCK_KEY)).resolves.toBe(true);

    const client = lastClient();
    expect(client.$queryRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = renderedQuery(client.$queryRaw.mock.calls[0][0]);
    // Session-scoped on purpose: it must survive transaction churn inside the
    // run and stay exclusive across processes until unlocked on this session.
    expect(sql).toContain("pg_try_advisory_lock(");
    expect(sql).not.toContain("pg_try_advisory_xact_lock");
    expect(values).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
  });

  it("reports 'not acquired' when another session holds the lock", async () => {
    PrismaClientMock.mockImplementation(function clientFactory(): ClientStub {
      return {
        $queryRaw: vi.fn().mockResolvedValue([{ locked: false }]),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      };
    });

    const connection = createSchedulerLockConnection();

    await expect(connection.tryAdvisoryLock(SCHEDULER_ADVISORY_LOCK_KEY)).resolves.toBe(false);
  });

  it("unlocks with pg_advisory_unlock on the SAME dedicated client and closes it on end()", async () => {
    const connection = createSchedulerLockConnection();

    await connection.tryAdvisoryLock(SCHEDULER_ADVISORY_LOCK_KEY);
    await connection.releaseAdvisoryLock(SCHEDULER_ADVISORY_LOCK_KEY);
    await connection.end();

    const client = lastClient();
    expect(client.$queryRaw).toHaveBeenCalledTimes(2); // try + unlock, one client instance
    const { sql, values } = renderedQuery(client.$queryRaw.mock.calls[1][0]);
    expect(sql).toContain("pg_advisory_unlock(");
    expect(values).toEqual([SCHEDULER_ADVISORY_LOCK_KEY]);
    expect(client.$disconnect).toHaveBeenCalledTimes(1);
  });

  it("propagates query failures (the scheduler turns them into a skip with a best-effort close)", async () => {
    PrismaClientMock.mockImplementation(function clientFactory(): ClientStub {
      return {
        $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      };
    });
    const connection = createSchedulerLockConnection();

    await expect(connection.tryAdvisoryLock(SCHEDULER_ADVISORY_LOCK_KEY)).rejects.toThrow("connection refused");
  });
});