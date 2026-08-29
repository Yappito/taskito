import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal stub of the PrismaClient surface the lock module uses: `$transaction`
 * (interactive form) + `$disconnect`. The interactive callback receives a `tx`
 * client whose `$queryRaw` is a separate mock — production runs the xact
 * try-lock on the TRANSACTION client, never on the outer client.
 */
interface ClientStub {
  $transaction: ReturnType<typeof vi.fn>;
  $disconnect: ReturnType<typeof vi.fn>;
}

interface TxStub {
  $queryRaw: ReturnType<typeof vi.fn>;
}

const { PrismaClientMock } = vi.hoisted(() => ({
  // Implementation is replaced per test with a constructible function (new PrismaClient()).
  PrismaClientMock: vi.fn(function clientCtor() {
    return { $transaction: vi.fn(), $disconnect: vi.fn() } as ClientStub;
  }),
}));

// Only the PrismaClient CLASS is mocked — everything else (Prisma.sql) comes
// from the real module; no query ever runs, so no actual database is needed.
vi.mock("@prisma/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@prisma/client")>();
  return { ...actual, PrismaClient: PrismaClientMock };
});

import {
  buildSingleSessionDatabaseUrl,
  createSchedulerLockConnection,
  DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS,
  schedulerLockTransactionTimeoutMs,
} from "@/server/services/scheduler-lock-connection";

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

/**
 * Wires the client stub so `$transaction` emulates Prisma's interactive form:
 * the callback is invoked with a `tx` client (its own `$queryRaw` mock), the
 * returned promise resolves with whatever the callback resolves, and
 * `commitFailure` simulates a COMMIT that fails AFTER the callback settled.
 */
function stubTransaction(options: { locked?: boolean; commitFailure?: Error } = {}) {
  const events: string[] = [];
  const txStub: TxStub = {
    $queryRaw: vi.fn().mockResolvedValue([{ locked: options.locked ?? true }]),
  };
  PrismaClientMock.mockImplementation(function clientFactory(): ClientStub {
    const client: ClientStub = {
      $transaction: vi.fn(async (callback: (tx: TxStub) => Promise<unknown>) => {
        events.push("tx-begin");
        try {
          const result = await callback(txStub);
          events.push("tx-callback-resolved");
          if (options.commitFailure) {
            throw options.commitFailure;
          }
          return result;
        } catch (error) {
          events.push("tx-aborted");
          throw error;
        }
      }),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
    return client;
  });
  return { events, txStub };
}

describe("scheduler lock connection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS;
    process.env.DATABASE_URL = "postgresql://scheduler:s3cret@db.local:5432/taskito?schema=public&pool_timeout=17";
    PrismaClientMock.mockImplementation(function clientFactory(): ClientStub {
      return {
        $transaction: vi.fn(),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      };
    });
  });

  afterEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS;
  });

  it("opens its own PrismaClient pinned to a single connection (never the shared pool)", () => {
    createSchedulerLockConnection();

    expect(PrismaClientMock).toHaveBeenCalledTimes(1);
    const { datasourceUrl } = lastConstructorArg();
    // The dedicated lock client is a SEPARATE PrismaClient with its own pool,
    // pinned to EXACTLY one connection. Its pool serves nothing but the ONE
    // pinned lock transaction, so the lock never occupies a connection from
    // the shared global pool the jobs use (finding 8), and no other client
    // activity can land on the pinned backend.
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

  it("defaults the lock-transaction timeout to 24h (far above any tick)", () => {
    delete process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS;
    expect(schedulerLockTransactionTimeoutMs()).toBe(DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS);
    expect(DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
  });

  it("reads SCHEDULER_LOCK_TX_TIMEOUT_MS and falls back to the default on invalid values", () => {
    process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS = "7200000";
    expect(schedulerLockTransactionTimeoutMs()).toBe(7_200_000);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS = "banana";
    expect(schedulerLockTransactionTimeoutMs()).toBe(DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS);
    process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS = "59999"; // below the 60s minimum
    expect(schedulerLockTransactionTimeoutMs()).toBe(DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[scheduler-lock] invalid SCHEDULER_LOCK_TX_TIMEOUT_MS"));
    warnSpy.mockRestore();
  });

  it("pins ONE interactive $transaction per run: try-lock inside it, callback awaited inside it", async () => {
    const { events, txStub } = stubTransaction({ locked: true });
    const connection = createSchedulerLockConnection();
    const KEY = 684_513_207;

    const result = await connection.runExclusive(KEY, async () => {
      events.push("work");
      return "ran";
    });

    // The callback's result is returned while the "transaction" wraps it.
    expect(result).toBe("ran");
    expect(events).toEqual(["tx-begin", "work", "tx-callback-resolved"]);

    // The whole run lives in exactly ONE $transaction on the dedicated
    // client — acquire and release are NOT two separate pooled queries.
    expect(lastClient().$transaction).toHaveBeenCalledTimes(1);
    // The lock query runs on the TRANSACTION client.
    expect(txStub.$queryRaw).toHaveBeenCalledTimes(1);
    const { sql, values } = renderedQuery(txStub.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain("pg_try_advisory_xact_lock(");
    expect(sql).not.toContain("pg_try_advisory_lock(");
    expect(sql).not.toContain("pg_advisory_unlock");
    expect(values).toEqual([KEY]);
    // The pinned transaction's timeout is the high, configurable one so
    // Prisma can never expire it (and the lock) mid-run.
    const txOptions = (lastClient().$transaction.mock.calls[0][1] ?? {}) as { timeout?: number };
    expect(txOptions.timeout).toBe(DEFAULT_SCHEDULER_LOCK_TX_TIMEOUT_MS);
  });

  it("runs the callback literally INSIDE the $transaction callback (pinned while it settles)", async () => {
    const { events } = stubTransaction({ locked: true });
    const connection = createSchedulerLockConnection();
    let insideTx = false;

    const run = connection.runExclusive(1, async () => {
      // Observed while the transaction callback is still on the stack.
      insideTx = events.includes("tx-begin") && !events.includes("tx-callback-resolved");
      return "done";
    });

    await expect(run).resolves.toBe("done");
    expect(insideTx).toBe(true);
  });

  it("returns null and ends the transaction immediately when the xact lock is held elsewhere", async () => {
    const { events, txStub } = stubTransaction({ locked: false });
    const connection = createSchedulerLockConnection();

    const result = await connection.runExclusive(684_513_207, async () => {
      throw new Error("must not run while another session holds the lock");
    });

    expect(result).toBeNull();
    expect(txStub.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["tx-begin", "tx-callback-resolved"]);
    // The empty transaction ended on its own (resolved, not aborted); the
    // callback never ran — it would have thrown, and the result is null.
  });

  it("uses SCHEDULER_LOCK_TX_TIMEOUT_MS for the pinned transaction's timeout", async () => {
    process.env.SCHEDULER_LOCK_TX_TIMEOUT_MS = "3600000";
    const { events } = stubTransaction({ locked: true });
    const connection = createSchedulerLockConnection();

    await connection.runExclusive(1, async () => {
      events.push("work");
    });

    const txOptions = (lastClient().$transaction.mock.calls[0][1] ?? {}) as { timeout?: number };
    expect(txOptions.timeout).toBe(3_600_000);
    expect(events).toContain("tx-callback-resolved");
  });

  it("propagates a callback failure (the transaction rolls back, releasing the xact lock)", async () => {
    const { events, txStub } = stubTransaction({ locked: true });
    const connection = createSchedulerLockConnection();

    await expect(
      connection.runExclusive(1, async () => {
        throw new Error("job exploded");
      }),
    ).rejects.toThrow("job exploded");

    // The wrap-up still happened inside the transaction: exactly one tx, the
    // try-lock ran once, and the transaction aborted (rollback releases the
    // xact lock server-side).
    expect(lastClient().$transaction).toHaveBeenCalledTimes(1);
    expect(txStub.$queryRaw).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["tx-begin", "tx-aborted"]);
  });

  it("keeps a settled run's result when the transaction ends badly (logged, like the old unlock-failure path)", async () => {
    const { events } = stubTransaction({ locked: true, commitFailure: new Error("commit failed: connection dropped") });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const connection = createSchedulerLockConnection();

    await expect(connection.runExclusive(1, async () => "ran")).resolves.toBe("ran");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[scheduler-lock] ending the lock transaction after a settled run failed"),
    );
    errorSpy.mockRestore();
    expect(events).toContain("tx-callback-resolved");
  });

  it("propagates lock-transaction failures that happen BEFORE the callback (scheduler turns them into a skip)", async () => {
    const txStub: TxStub = { $queryRaw: vi.fn().mockRejectedValue(new Error("connection refused")) };
    PrismaClientMock.mockImplementation(function clientFactory(): ClientStub {
      return {
        $transaction: vi.fn(async (callback: (tx: TxStub) => Promise<unknown>) => callback(txStub)),
        $disconnect: vi.fn().mockResolvedValue(undefined),
      };
    });
    const connection = createSchedulerLockConnection();

    await expect(connection.runExclusive(1, async () => "never")).rejects.toThrow("connection refused");
  });

  it("closes the dedicated client via end() after every run path", async () => {
    const { events } = stubTransaction({ locked: true });
    const connection = createSchedulerLockConnection();

    await connection.runExclusive(1, async () => "ran");
    await connection.end();

    expect(lastClient().$disconnect).toHaveBeenCalledTimes(1);
    expect(events).toContain("tx-callback-resolved");
  });
});