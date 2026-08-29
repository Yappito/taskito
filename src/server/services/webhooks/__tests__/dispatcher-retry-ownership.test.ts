import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/secret-crypto";
import {
  deliverWebhook,
  emitWebhookEvent,
  outboundDeliveryQueueState,
  processDueWebhookDeliveries,
  recoverExpiredWebhookDeliveryLeases,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from "@/server/services/webhooks/dispatcher";
import type { PrismaMock } from "@/test/prisma-mock";
import { createPrismaMock } from "@/test/prisma-mock";

// Public IP literal — skips DNS resolution entirely (offline sandbox).
const PUBLIC_URL = "https://93.184.216.34/hook";
const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
const T0 = new Date("2026-01-01T00:00:00.000Z");

interface DeliveryRow {
  id: string;
  status: string;
  attempts: number;
  claimToken: string | null;
  leaseExpiresAt: Date | null;
  nextAttemptAt: Date;
  responseCode: number | null;
  lastError: string | null;
}

interface UpdateManyArgs {
  where?: {
    id?: string;
    status?: string;
    claimToken?: string;
    nextAttemptAt?: { lte?: Date };
    leaseExpiresAt?: { lte?: Date };
    OR?: Array<Record<string, unknown>>;
  };
  data: Record<string, unknown>;
}

function webhookRowFor(secret: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "wh1",
    url: PUBLIC_URL,
    encryptedSecret: encryptSecret(secret),
    isEnabled: true,
    projectId: "p1",
    createdByUserId: "creator-1",
    ...overrides,
  };
}

/**
 * Full-fidelity in-memory model of the WebhookDelivery claim lifecycle. Every
 * updateMany is evaluated against the live row exactly like Postgres evaluates
 * `UPDATE ... WHERE <predicate>`: status, claim-token, lease-expiry, due-time
 * and OR predicates are all enforced. This is what makes the retry-requeue and
 * owner-token tests mutation-provable — a reverted fix strands the row (or
 * lets a stale worker clobber the new claim) and the test fails.
 */
function statefulDeliveryStore(initial: Partial<DeliveryRow> = {}) {
  const row: DeliveryRow = {
    id: "delivery-1",
    status: initial.status ?? "pending",
    attempts: initial.attempts ?? 0,
    claimToken: initial.claimToken ?? null,
    leaseExpiresAt: initial.leaseExpiresAt ?? null,
    nextAttemptAt: initial.nextAttemptAt ?? T0,
    responseCode: initial.responseCode ?? null,
    lastError: initial.lastError ?? null,
  };
  const claimedTokens: string[] = [];

  const updateMany = vi.fn(async (args: UpdateManyArgs) => {
    const where = args.where ?? {};
    const data = args.data ?? {};

    if (where.id && where.id !== row.id) {
      return { count: 0 };
    }
    if (where.status && where.status !== row.status) {
      return { count: 0 };
    }
    // Claim-owner predicate: only the worker holding the current token matches.
    if (where.claimToken !== undefined && where.claimToken !== row.claimToken) {
      return { count: 0 };
    }
    if (where.nextAttemptAt?.lte && row.nextAttemptAt > where.nextAttemptAt.lte) {
      return { count: 0 };
    }
    if (where.leaseExpiresAt?.lte && !(row.leaseExpiresAt && row.leaseExpiresAt <= where.leaseExpiresAt.lte)) {
      return { count: 0 };
    }
    if (where.OR?.length) {
      const matches = where.OR.some((branch) => {
        const status = typeof branch.status === "string" ? (branch.status as string) : undefined;
        if (status !== undefined && status !== row.status) {
          return false;
        }
        const nested = (branch.OR ?? []) as Array<Record<string, unknown>>;
        if (nested.length === 0) {
          return true;
        }
        return nested.some((sub) => {
          if ("leaseExpiresAt" in sub && sub.leaseExpiresAt === null) {
            return row.leaseExpiresAt === null;
          }
          if (sub.leaseExpiresAt && typeof sub.leaseExpiresAt === "object" && "lte" in sub.leaseExpiresAt) {
            return row.leaseExpiresAt !== null && row.leaseExpiresAt <= (sub.leaseExpiresAt as { lte: Date }).lte;
          }
          return false;
        });
      });
      if (!matches) {
        return { count: 0 };
      }
    }

    if (typeof data.status === "string") {
      if (data.status === "processing" && typeof data.claimToken === "string") {
        claimedTokens.push(data.claimToken);
      }
      row.status = data.status;
    }
    if (data.attempts && typeof data.attempts === "object") {
      if ("increment" in data.attempts && data.attempts.increment) {
        row.attempts += data.attempts.increment as number;
      }
      if ("set" in data.attempts && data.attempts.set !== undefined) {
        row.attempts = data.attempts.set as number;
      }
    }
    if ("claimToken" in data) {
      row.claimToken = (data.claimToken as string | null) ?? null;
    }
    if ("leaseExpiresAt" in data) {
      row.leaseExpiresAt = (data.leaseExpiresAt as Date | null) ?? null;
    }
    if (data.nextAttemptAt) {
      row.nextAttemptAt = data.nextAttemptAt as Date;
    }
    if ("responseCode" in data) {
      row.responseCode = (data.responseCode as number | null) ?? null;
    }
    if ("lastError" in data) {
      row.lastError = (data.lastError as string | null) ?? null;
    }
    return { count: 1 };
  });

  /** Wires the store into a prisma mock (findUnique reads the live row). */
  function wire(prisma: PrismaMock, webhookOverrides: Record<string, unknown> = {}) {
    prisma.webhookDelivery.updateMany.mockImplementation(updateMany as never);
    prisma.webhookDelivery.findUnique.mockImplementation(async () => ({
      ...row,
      event: "task.created",
      payload: {},
      webhook: webhookRowFor("whsec_test_secret", webhookOverrides),
    }));
    // The scheduler sweep selects pending due rows — model that predicate.
    prisma.webhookDelivery.findMany.mockImplementation(async (args?: {
      where?: { status?: string; nextAttemptAt?: { lte?: Date } };
    }) => {
      if (args?.where?.status !== "pending") {
        return [];
      }
      const due = !args.where.nextAttemptAt?.lte || row.nextAttemptAt <= args.where.nextAttemptAt.lte;
      return row.status === "pending" && due ? [{ id: row.id }] : [];
    });
  }

  return { row, updateMany, wire, claimedTokens };
}

/** Transport that records each request and lets the test resolve the POST manually. */
function parkedTransport() {
  const requests: Array<Record<string, unknown>> = [];
  let releaseFn: ((result: { status: number; error: string | null }) => void) | null = null;
  const transport = vi.fn(async (): Promise<{ status: number; error: string | null }> => {
    requests.push({});
    return new Promise((resolve) => {
      releaseFn = resolve;
    });
  });
  return {
    transport,
    requestCount: () => requests.length,
    release: (result: { status: number; error: string | null }) => releaseFn?.(result),
  };
}

/** Transport that answers every POST immediately with a fixed status. */
function instantTransport(status = 200) {
  const requests: number[] = [];
  const transport = vi.fn(async (): Promise<{ status: number; error: string | null }> => {
    requests.push(status);
    return { status, error: null };
  });
  return { transport, requestCount: () => requests.length };
}

type ParkingResolver = (result: { status: number; error: string | null }) => void;

/** Disposing helper for multi-request parked transports (queue drain tests). */
function parkedTransportWithResolvers() {
  const requests: Array<Record<string, unknown>> = [];
  const resolvers: Array<ParkingResolver> = [];
  const transport = vi.fn(async (): Promise<{ status: number; error: string | null }> => {
    requests.push({});
    return new Promise((resolve) => {
      resolvers.push(resolve);
    });
  });
  const releaseAll = (result: { status: number; error: string | null }) => {
    for (const resolve of resolvers.splice(0)) {
      resolve(result);
    }
  };
  return { transport, requestCount: () => requests.length, releaseAll };
}

/** Stubs the dispatcher's send-time creator re-check. Defaults to an enabled manager. */
function stubCreatorAccess(
  prisma: PrismaMock,
  user: { disabledAt?: Date | null; role?: string; grants?: Array<{ permission: string; allowed: boolean }> } = {},
) {
  prisma.user.findUnique.mockImplementation(async (args?: { where?: { id?: string }; select?: Record<string, unknown> }) => {
    if (args?.select && "projectMemberships" in args.select) {
      return {
        id: "creator-1",
        role: user.role ?? "manager",
        disabledAt: user.disabledAt ?? null,
        projectMemberships: [{ role: "manager" }],
        projectPermissionGrants: user.grants ?? [],
        groupMemberships: [],
      };
    }
    return { id: args?.where?.id ?? "creator-1", name: "Actor One" };
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe("webhook delivery retry requeue + claim ownership", () => {
  beforeEach(() => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_HOSTS", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe("finding 1 — non-terminal failures requeue the owned claim (retry regression)", () => {
    it("a first-attempt failure leaves the row PENDING with a future nextAttemptAt, and a later sweep re-delivers it (mutation-provable)", async () => {
      const prisma = createPrismaMock();
      const store = statefulDeliveryStore();
      store.wire(prisma);
      stubCreatorAccess(prisma);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport, requestCount } = instantTransport(500);

      // Sweep #1: the very first POST fails with HTTP 500.
      const first = await processDueWebhookDeliveries(prisma as never, T0, { transport });

      expect(first.processed).toBe(1);
      expect(first.succeeded).toBe(0);
      // The row must NOT stay `processing`: with a null lease it is invisible
      // to the pending sweep AND unrecoverable by lease recovery. It is back
      // to PENDING, with a future nextAttemptAt.
      expect(store.row.status).toBe("pending");
      expect(store.row.attempts).toBe(1);
      expect(store.row.nextAttemptAt).toEqual(new Date(T0.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]));
      expect(store.row.nextAttemptAt.getTime()).toBeGreaterThan(T0.getTime());
      expect(store.row.leaseExpiresAt).toBeNull();
      expect(store.row.claimToken).toBeNull();
      expect(store.row.lastError).toMatch(/HTTP status 500/);
      expect(requestCount()).toBe(1);

      // Sweep #2 at the backoff moment: the sweep RE-CLAIMS and re-delivers.
      const t1 = new Date(T0.getTime() + WEBHOOK_RETRY_DELAYS_MS[0] + 1);
      const second = await processDueWebhookDeliveries(prisma as never, t1, { transport });

      expect(second.processed).toBe(1);
      expect(store.row.attempts).toBe(2);
      expect(store.row.status).toBe("pending");
      expect(requestCount()).toBe(2);

      // Sweep #3 after the full ladder: attempts exhausted -> failed.
      const t2 = new Date(new Date(T0.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]).getTime() + WEBHOOK_RETRY_DELAYS_MS[1] + 1);
      await processDueWebhookDeliveries(prisma as never, t2, { transport });
      expect(store.row.status).toBe("failed");
      expect(store.row.attempts).toBe(3);
    });

    it("a decrypt failure retries up to WEBHOOK_MAX_ATTEMPTS (requeued as pending each round) and only then marks the row failed", async () => {
      // Ciphertext that decrypts under NO configured key (post-key-rotation).
      const prisma = createPrismaMock();
      const store = statefulDeliveryStore();
      store.wire(prisma, { encryptedSecret: "v1:c2hvcnRjaXBoZXJ0ZXh0" });
      stubCreatorAccess(prisma);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport, requestCount } = instantTransport(200);

      let when = T0;
      for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt += 1) {
        const result = await deliverWebhook(prisma as never, "delivery-1", { now: when, transport });

        if (attempt < WEBHOOK_MAX_ATTEMPTS) {
          // Still schedulable after every non-exhausted failure.
          expect(result.status).toBe("pending");
          expect(store.row.status).toBe("pending");
          expect(store.row.attempts).toBe(attempt);
          const delay = WEBHOOK_RETRY_DELAYS_MS[Math.min(attempt - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
          expect(store.row.nextAttemptAt).toEqual(new Date(when.getTime() + delay));
          expect(store.row.leaseExpiresAt).toBeNull();
          expect(store.row.claimToken).toBeNull();
          expect(store.row.lastError).toMatch(/could not be decrypted/);
          when = new Date(store.row.nextAttemptAt.getTime() + 1);
        } else {
          expect(result.status).toBe("failed");
          expect(store.row.status).toBe("failed");
          expect(store.row.attempts).toBe(WEBHOOK_MAX_ATTEMPTS);
          expect(store.row.leaseExpiresAt).toBeNull();
        }
      }
      // A decrypt failure can never POST (there is no secret to sign with).
      expect(requestCount()).toBe(0);
    });
  });

  describe("finding 2 — claim owner-token exclusivity", () => {
    it("two concurrent claimers: exactly one claims and delivers", async () => {
      const prisma = createPrismaMock();
      const store = statefulDeliveryStore();
      store.wire(prisma);
      stubCreatorAccess(prisma);

      const { transport, requestCount } = instantTransport(200);

      const [a, b] = (await Promise.all([
        deliverWebhook(prisma as never, "delivery-1", { now: T0, transport }),
        deliverWebhook(prisma as never, "delivery-1", { now: T0, transport }),
      ])) as Array<{ status: string }>;

      expect([a.status, b.status].filter((s) => s === "success")).toHaveLength(1);
      expect([a.status, b.status].filter((s) => s === "skipped")).toHaveLength(1);
      expect(requestCount()).toBe(1);
      expect(store.row.status).toBe("success");
      expect(store.row.attempts).toBe(1);
      // Exactly one claim was minted (the claim itself is exclusive).
      expect(store.claimedTokens).toHaveLength(1);
    });

    it("after a lease-expiry recovery + re-claim, the OLD worker's success finalize is rejected by the claim token", async () => {
      const prisma = createPrismaMock();
      const store = statefulDeliveryStore();
      store.wire(prisma);
      stubCreatorAccess(prisma);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // Worker A claims and parks mid-POST.
      const parkedA = parkedTransport();
      const promiseA = deliverWebhook(prisma as never, "delivery-1", { now: T0, transport: parkedA.transport });
      await waitFor(() => store.row.status === "processing" && store.row.attempts === 1);
      const tokenA = store.row.claimToken;
      expect(tokenA).toEqual(expect.any(String));

      // A "crashes" (never finalizes). The lease expires; recovery hands the
      // row back to pending and revokes the old token.
      const recoveredAt = new Date((store.row.leaseExpiresAt as Date).getTime() + 1);
      await recoverExpiredWebhookDeliveryLeases(prisma as never, recoveredAt);
      expect(store.row.status).toBe("pending");
      expect(store.row.claimToken).toBeNull();
      expect(store.row.nextAttemptAt).toEqual(recoveredAt);

      // Worker B re-claims (new token) and parks mid-POST too.
      const parkedB = parkedTransport();
      const promiseB = deliverWebhook(prisma as never, "delivery-1", { now: new Date(recoveredAt.getTime() + 1), transport: parkedB.transport });
      await waitFor(() => store.row.attempts === 2 && store.row.status === "processing");
      const tokenB = store.row.claimToken;
      expect(tokenB).toEqual(expect.any(String));
      expect(tokenB).not.toEqual(tokenA);

      // A's POST finally "completes": its finalize must be rejected — the row
      // now belongs to B, and B's claim is left completely untouched.
      parkedA.release({ status: 200, error: null });
      const resultA = (await promiseA) as { status: string };
      expect(store.row.status).toBe("processing");
      expect(store.row.claimToken).toEqual(tokenB);
      expect(store.row.attempts).toBe(2);
      expect(store.row.responseCode).toBeNull();

      // B delivers normally.
      parkedB.release({ status: 200, error: null });
      const resultB = (await promiseB) as { status: string };
      expect(resultB.status).toBe("success");
      expect(store.row.status).toBe("success");
      expect(store.row.attempts).toBe(2);

      // Exactly two POSTs ever happened (A's original + B's re-claim) — the
      // stale worker never re-delivered on top of B.
      expect(parkedA.requestCount() + parkedB.requestCount()).toBe(2);
      void resultA;
    });

    it("a stale worker's failure/requeue write is likewise rejected by the claim token", async () => {
      const prisma = createPrismaMock();
      const store = statefulDeliveryStore();
      store.wire(prisma);
      stubCreatorAccess(prisma);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      // Worker A claims and parks mid-POST.
      const parkedA = parkedTransport();
      const promiseA = deliverWebhook(prisma as never, "delivery-1", { now: T0, transport: parkedA.transport });
      await waitFor(() => store.row.status === "processing" && store.row.attempts === 1);
      const tokenA = store.row.claimToken;

      // Lease expires; recovery hands the row back to pending; B re-claims.
      const recoveredAt = new Date((store.row.leaseExpiresAt as Date).getTime() + 1);
      await recoverExpiredWebhookDeliveryLeases(prisma as never, recoveredAt);
      const parkedB = parkedTransport();
      const promiseB = deliverWebhook(prisma as never, "delivery-1", { now: new Date(recoveredAt.getTime() + 1), transport: parkedB.transport });
      await waitFor(() => store.row.attempts === 2 && store.row.status === "processing");
      const tokenB = store.row.claimToken;
      expect(tokenB).not.toEqual(tokenA);
      const nextAttemptAtBeforeStaleWrite = store.row.nextAttemptAt;

      // A's POST fails with a 500: its requeue (gated on A's stale token)
      // must be rejected and must NOT reschedule B's claim.
      parkedA.release({ status: 500, error: null });
      await promiseA;

      expect(store.row.status).toBe("processing");
      expect(store.row.claimToken).toEqual(tokenB);
      expect(store.row.attempts).toBe(2);
      // The requeue would have reset nextAttemptAt to a backoff date — it did
      // not, because the stale write matched 0 rows.
      expect(store.row.nextAttemptAt).toEqual(nextAttemptAtBeforeStaleWrite);

      // B still owns the claim and delivers normally.
      parkedB.release({ status: 200, error: null });
      const resultB = (await promiseB) as { status: string };
      expect(resultB.status).toBe("success");
      expect(store.row.status).toBe("success");
    });
  });

  describe("finding 3 — send-time authorization recheck", () => {
    it("never POSTs (and fails closed) when the creator was disabled after enqueue", async () => {
      const prisma = createPrismaMock();
      const store = statefulDeliveryStore();
      store.wire(prisma);
      stubCreatorAccess(prisma, { disabledAt: new Date() });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport, requestCount } = instantTransport(200);

      const result = await deliverWebhook(prisma as never, "delivery-1", { now: T0, transport });

      expect(requestCount()).toBe(0);
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/automation_manage \+ task_read/);
      // Cancelled under the claim's own token, terminal (failed).
      expect(store.claimedTokens).toHaveLength(1);
      expect(store.row.status).toBe("failed");
      expect(store.row.leaseExpiresAt).toBeNull();
      expect(store.row.lastError).toMatch(/automation_manage \+ task_read/);
    });

    it("never POSTs when the creator's task_read was denied after enqueue", async () => {
      const prisma = createPrismaMock();
      const store = statefulDeliveryStore();
      store.wire(prisma);
      stubCreatorAccess(prisma, { grants: [{ permission: "task_read", allowed: false }] });
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport, requestCount } = instantTransport(200);

      const result = await deliverWebhook(prisma as never, "delivery-1", { now: T0, transport });

      expect(requestCount()).toBe(0);
      expect(result.status).toBe("failed");
      expect(store.row.status).toBe("failed");
    });
  });

  describe("finding 4 — queue depth backpressure", () => {
    it("caps the inline queue depth; dropped deliveries rely on their durable pending rows + sweep", async () => {
      vi.stubEnv("WEBHOOK_DELIVERY_CONCURRENCY", "1");
      vi.stubEnv("WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH", "2");

      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.webhook.findMany.mockResolvedValue(
        Array.from({ length: 10 }, (_, index) => ({ id: `wh${index}`, createdByUserId: "creator-1" })),
      );
      stubCreatorAccess(prisma);
      let seq = 0;
      prisma.webhookDelivery.create.mockImplementation(async () => ({ id: `delivery-${++seq}` }));
      prisma.webhookDelivery.update.mockResolvedValue({});
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      // Each claimed delivery must actually reach the transport.
      prisma.webhookDelivery.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
        id: args.where.id,
        status: "pending",
        attempts: 0,
        payload: {},
        event: "task.created",
        webhook: webhookRowFor("whsec_test_secret"),
      }));
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const parked = parkedTransportWithResolvers();

      const result = await emitWebhookEvent(prisma as never, {
        projectId: "p1",
        event: "task.created",
        transport: parked.transport,
      });

      // Every webhook got a durable pending delivery row…
      expect(result.delivered).toBe(10);
      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(10);

      // …but the in-process inline queue never grew past the depth cap: 1
      // active + 2 queued; the other 7 rely on the durable rows + sweep.
      await waitFor(() => parked.requestCount() === 1);
      expect(outboundDeliveryQueueState()).toEqual({ queued: 2, active: 1 });

      // Drain the parked worker and queued items so later tests start clean.
      await waitFor(() => {
        parked.releaseAll({ status: 200, error: null });
        return outboundDeliveryQueueState().queued === 0 && outboundDeliveryQueueState().active === 0;
      });
      // 1 active + 2 queued = 3 POSTs; the other 7 are picked up by the sweep.
      expect(parked.requestCount()).toBe(3);
    });
  });
});