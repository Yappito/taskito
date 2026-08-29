import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/secret-crypto";
import { createPinnedOutboundLookup } from "@/lib/ai-provider-validation";
import {
  webhookDeliveryLeaseMs,
  webhookDeliveryPreflightDeadlineMs,
  webhookLeaseMarginMs,
  webhookRequestTimeoutMs,
} from "@/lib/webhook-limits";
import {
  buildWebhookTaskSnapshot,
  defaultWebhookTransport,
  deliverWebhook,
  emitWebhookEvent,
  outboundDeliveryQueueState,
  processDueWebhookDeliveries,
  sendWebhookPing,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  type DeliverWebhookOptions,
  type WebhookOutboundRequest,
  type WebhookOutboundResponse,
} from "@/server/services/webhooks/dispatcher";
import { computeWebhookSignature } from "@/server/services/webhooks/signature";
import { createPrismaMock } from "@/test/prisma-mock";

// Public IP literal (skips DNS resolution entirely — see
// `isIpLiteralHostname` in ai-provider-validation.ts) so "allowed" tests never
// touch the network in this offline sandbox.
const PUBLIC_URL = "https://93.184.216.34/hook";
const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

// ---------------------------------------------------------------------------
// DNS mock: `node:dns/promises` is replaced file-wide. Validation-time
// lookups are fully controllable so tests can simulate DNS rebinding
// (validation answers public, later/connect-time answers private).
// ---------------------------------------------------------------------------
const { dnsLookupMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
}));
vi.mock("node:dns/promises", () => ({
  lookup: dnsLookupMock,
}));

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

interface MockDeliveryRow {
  id: string;
  status: string;
  attempts: number;
  payload: unknown;
  event: string;
  webhook: Record<string, unknown>;
}

/**
 * Stubs `prisma.user.findUnique` for the dispatcher's send-time creator
 * re-check (`getEffectiveProjectAccess`). Defaults to an enabled manager —
 * i.e. the creator holds `automation_manage` + `task_read` and deliveries may
 * go out. Pass overrides to simulate a disabled/demoted creator.
 */
function stubCreatorAccess(
  prisma: ReturnType<typeof createPrismaMock>,
  user: {
    disabledAt?: Date | null;
    role?: string;
    projectMemberships?: Array<{ role: string }>;
    grants?: Array<{ permission: string; allowed: boolean }>;
  } = {},
) {
  prisma.user.findUnique.mockImplementation(async (args?: { where?: { id?: string }; select?: Record<string, unknown> }) => {
    if (args?.select && "projectMemberships" in args.select) {
      return {
        id: "creator-1",
        role: user.role ?? "manager",
        disabledAt: user.disabledAt ?? null,
        projectMemberships: user.projectMemberships ?? [{ role: "manager" }],
        projectPermissionGrants: user.grants ?? [],
        groupMemberships: [],
      };
    }
    return { id: args?.where?.id ?? "creator-1", name: "Actor One" };
  });
}

function pendingDeliveryRow(webhook: Record<string, unknown>, overrides: Partial<MockDeliveryRow> = {}): MockDeliveryRow {
  return {
    id: "delivery-1",
    status: "pending",
    attempts: 0,
    payload: {},
    event: "task.created",
    webhook,
    ...overrides,
  };
}

/** Injectable fake transport recording each request (replacement for a fake global fetch). */
function recordingTransport(handler?: (request: WebhookOutboundRequest) => WebhookOutboundResponse) {
  const requests: WebhookOutboundRequest[] = [];
  const transport = vi.fn(async (request: WebhookOutboundRequest): Promise<WebhookOutboundResponse> => {
    requests.push(request);
    return handler?.(request) ?? { status: 200, error: null };
  });
  return { transport, requests };
}

/** Async result of the pinned lookup, as the HTTP agent would invoke it at connect time. */
function invokePinnedLookup(
  lookup: NonNullable<WebhookOutboundRequest["lookup"]>,
  options: { all?: boolean } = {},
): Promise<Array<{ address: string; family: number }> | { address: string; family: number }> {
  return new Promise((resolve, reject) => {
    lookup("whatever-hostname.agent-asks.example", options, (err, address, family) => {
      if (err) {
        reject(err);
        return;
      }
      if (Array.isArray(address)) {
        resolve(address);
      } else {
        resolve({ address: address as string, family: family as number });
      }
    });
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

describe("webhook dispatcher", () => {
  beforeEach(() => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_HOSTS", "false");
    vi.stubEnv("WEBHOOK_DELIVERY_CONCURRENCY", "5");
    dnsLookupMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("buildWebhookTaskSnapshot", () => {
    it("whitelists only id/key/title/statusId/assigneeId/priority/dueDate", () => {
      const sensitive = {
        id: "task-1",
        taskNumber: 42,
        title: "Fix the thing",
        statusId: "status-1",
        assigneeId: "user-1",
        priority: "high",
        dueDate: new Date("2026-02-01T00:00:00.000Z"),
        body: "SUPER SECRET task body text",
        description: { type: "doc", content: "also secret" },
        creator: { email: "creator@example.com" },
        assignee: { email: "assignee@example.com" },
      };

      const snapshot = buildWebhookTaskSnapshot(sensitive, "AAA");

      expect(snapshot).toEqual({
        id: "task-1",
        key: "AAA-42",
        title: "Fix the thing",
        statusId: "status-1",
        assigneeId: "user-1",
        priority: "high",
        dueDate: "2026-02-01T00:00:00.000Z",
      });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain("SUPER SECRET");
      expect(serialized).not.toContain("also secret");
      expect(serialized).not.toContain("creator@example.com");
      expect(serialized).not.toContain("assignee@example.com");
      expect(serialized).not.toMatch(/body|description|email/i);
    });
  });

  describe("creator permission gate (delivery build time)", () => {
    /**
     * Wires `prisma.user.findUnique` for both the envelope actor lookup and
     * the dispatcher's creator re-check (`getEffectiveProjectAccess`), keyed
     * on the requested `select` shape exactly like `@/test/actors` does for
     * the router suites.
     */
    function stubUserAccess(prisma: ReturnType<typeof createPrismaMock>, grants: Array<{ permission: string; allowed: boolean }>) {
      prisma.user.findUnique.mockImplementation(async (args?: { where?: { id?: string }; select?: Record<string, unknown> }) => {
        if (args?.select && "projectMemberships" in args.select) {
          return {
            id: "creator-1",
            role: "member",
            disabledAt: null,
            projectMemberships: [{ role: "manager" }],
            projectPermissionGrants: grants,
            groupMemberships: [],
          };
        }
        return { id: args?.where?.id ?? "creator-1", name: "Actor One" };
      });
    }

    it("delivers to webhooks whose creator holds automation_manage + task_read", async () => {
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.webhook.findMany.mockResolvedValue([{ id: "wh1", createdByUserId: "creator-1" }]);
      stubUserAccess(prisma, []);
      prisma.webhookDelivery.create.mockResolvedValue({ id: "delivery-1" });
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(
        pendingDeliveryRow(webhookRowFor("whsec_x")),
      );

      const { transport } = recordingTransport();
      const result = await emitWebhookEvent(prisma as never, {
        projectId: "p1",
        event: "task.created",
        transport,
      });

      expect(result.delivered).toBe(1);
      // The queue delivery is fire-and-forget: wait for it to complete.
      await waitFor(() => transport.mock.calls.length === 1);
      // The queue drained completely.
      expect(outboundDeliveryQueueState()).toEqual({ queued: 0, active: 0 });
    });

    it("stops delivering for a webhook whose creator lost task_read (confused-deputy exfil guard)", async () => {
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.webhook.findMany.mockResolvedValue([{ id: "wh1", createdByUserId: "creator-1" }]);
      stubUserAccess(prisma, [{ permission: "task_read", allowed: false }]);
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport } = recordingTransport(() => {
        throw new Error("delivery must not be built for a task_read-denied creator");
      });
      const result = await emitWebhookEvent(prisma as never, {
        projectId: "p1",
        event: "task.created",
        transport,
      });

      expect(result.delivered).toBe(0);
      expect(transport).not.toHaveBeenCalled();
      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    });
  });

  describe("emitWebhookEvent", () => {
    function stubEmitSuccess(prisma: ReturnType<typeof createPrismaMock>) {
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.user.findUnique.mockImplementation(async (args?: { where?: { id?: string }; select?: Record<string, unknown> }) => {
        if (args?.select && "projectMemberships" in args.select) {
          return {
            id: "creator-1",
            role: "member",
            disabledAt: null,
            projectMemberships: [{ role: "manager" }],
            projectPermissionGrants: [],
            groupMemberships: [],
          };
        }
        return { id: "actor1", name: "Actor One" };
      });
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
        pendingDeliveryRow(webhookRowFor("whsec_x", { id: "wh1" }), { id: args.where.id }),
      );
    }

    it("creates one delivery per enabled+subscribed webhook with a whitelisted payload", async () => {
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.webhook.findMany.mockResolvedValue([
        { id: "wh1", createdByUserId: "creator-1" },
        { id: "wh2", createdByUserId: "creator-1" },
      ]);
      stubEmitSuccess(prisma);
      let seq = 0;
      prisma.webhookDelivery.create.mockImplementation(async () => ({ id: `delivery-${++seq}` }));
      prisma.webhookDelivery.update.mockResolvedValue({});

      const sensitiveTask = {
        id: "task-1",
        taskNumber: 42,
        title: "Fix the thing",
        statusId: "status-1",
        assigneeId: "user-1",
        priority: "high",
        dueDate: new Date("2026-02-01T00:00:00.000Z"),
        body: "SUPER SECRET task body text",
        creator: { email: "creator@example.com" },
      };

      const { transport, requests } = recordingTransport();
      const result = await emitWebhookEvent(prisma as never, {
        projectId: "p1",
        event: "task.created",
        actorId: "actor1",
        payload: { task: sensitiveTask },
        transport,
      });
      await waitFor(() => requests.length === 2);

      expect(result.delivered).toBe(2);
      expect(prisma.webhook.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ projectId: "p1", isEnabled: true, events: { has: "task.created" } }),
        }),
      );
      expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(2);

      const firstCreateArgs = prisma.webhookDelivery.create.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(firstCreateArgs.data.webhookId).toBe("wh1");
      const storedPayload = firstCreateArgs.data.payload as Record<string, unknown>;
      expect(storedPayload.task).toEqual({
        id: "task-1",
        key: "AAA-42",
        title: "Fix the thing",
        statusId: "status-1",
        assigneeId: "user-1",
        priority: "high",
        dueDate: "2026-02-01T00:00:00.000Z",
      });
      expect(storedPayload.actor).toEqual({ id: "actor1", name: "Actor One" });

      const serialized = JSON.stringify(storedPayload);
      expect(serialized).not.toContain("SUPER SECRET");
      expect(serialized).not.toContain("creator@example.com");

      // The delivery id is stamped into the payload via a follow-up update.
      const firstUpdateArgs = prisma.webhookDelivery.update.mock.calls[0][0] as {
        where: { id: string };
        data: { payload: Record<string, unknown> };
      };
      expect(firstUpdateArgs.where.id).toBe("delivery-1");
      expect(firstUpdateArgs.data.payload.id).toBe("delivery-1");
    });

    it("returns delivered:0 for an unrecognized event without querying the database", async () => {
      const prisma = createPrismaMock();
      const result = await emitWebhookEvent(prisma as never, { projectId: "p1", event: "not.a.real.event" });
      expect(result.delivered).toBe(0);
      expect(prisma.project.findUnique).not.toHaveBeenCalled();
    });

    it("returns delivered:0 when the project has no matching webhooks", async () => {
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.webhook.findMany.mockResolvedValue([]);
      const result = await emitWebhookEvent(prisma as never, { projectId: "p1", event: "task.created" });
      expect(result.delivered).toBe(0);
      expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
    });

    it("bounds outbound delivery concurrency through the worker/queue (no immediate fetch per webhook)", async () => {
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.webhook.findMany.mockResolvedValue(
        Array.from({ length: 7 }, (_, index) => ({ id: `wh${index}`, createdByUserId: "creator-1" })),
      );
      stubEmitSuccess(prisma);
      let seq = 0;
      prisma.webhookDelivery.create.mockImplementation(async () => ({ id: `delivery-${++seq}` }));

      let inFlight = 0;
      let maxInFlight = 0;
      const resolveFns = new Map<string, () => void>();
      const transport = vi.fn(async (request: WebhookOutboundRequest): Promise<WebhookOutboundResponse> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<WebhookOutboundResponse>((resolve) => {
          const deliveryId = request.headers["x-taskito-delivery"];
          resolveFns.set(deliveryId, () => {
            inFlight -= 1;
            resolve({ status: 200, error: null });
          });
        });
      });

      const emitted = await emitWebhookEvent(prisma as never, {
        projectId: "p1",
        event: "task.created",
        transport,
      });
      expect(emitted.delivered).toBe(7);
      // While nothing resolves, at most WEBHOOK_DELIVERY_CONCURRENCY posts run.
      await waitFor(() => transport.mock.calls.length >= 5);
      expect(transport).toHaveBeenCalledTimes(5);
      expect(maxInFlight).toBe(5);

      // Freeing one slot releases exactly one queued delivery.
      [...resolveFns.values()][0]();
      await waitFor(() => transport.mock.calls.length === 6);

      // Drain: keep resolving every registered resolver (deliveries queued
      // later register fresh ones) until all 7 have run to completion and the
      // queue has fully drained — none are lost or left behind.
      await waitFor(() => {
        for (const resolveFn of [...resolveFns.values()]) {
          resolveFn();
        }
        return (
          transport.mock.calls.length === 7 &&
          outboundDeliveryQueueState().queued === 0 &&
          outboundDeliveryQueueState().active === 0
        );
      });

      expect(maxInFlight).toBeLessThanOrEqual(5);
      expect(maxInFlight).toBeGreaterThan(1);
    });
  });

  describe("deliverWebhook — exclusive, owned claim (processing state)", () => {
    /**
     * Models the real SQL behind the claim lifecycle: the claim is
     * `UPDATE ... SET status='processing', attempts=attempts+1, claim_token=?
     * WHERE id=? AND status='pending' AND next_attempt_at <= now` and every
     * finalize/requeue is guarded by the OWNED claim token (`WHERE id AND
     * status='processing' AND claim_token=?`). Claim predicates are applied
     * against the live row state — exactly one concurrent UPDATE matches, so
     * exactly one worker proceeds, and only the token owner finalizes.
     */
    function exclusiveDeliveryStore() {
      const row = {
        id: "delivery-1",
        status: "pending" as string,
        attempts: 0,
        claimToken: null as string | null,
        leaseExpiresAt: null as Date | null,
        nextAttemptAt: new Date(0),
        responseCode: null as number | null,
        lastError: null as string | null,
      };
      const updateMany = vi.fn(
        async (args: {
          where: {
            id?: string;
            status?: string;
            claimToken?: string;
            nextAttemptAt?: { lte?: Date };
            leaseExpiresAt?: { lte?: Date };
            OR?: Array<Record<string, unknown>>;
          };
          data: {
            status?: string;
            attempts?: { increment?: number } | { set?: number };
            claimToken?: string | null;
            leaseExpiresAt?: Date | null;
            nextAttemptAt?: Date;
            responseCode?: number | null;
            lastError?: string | null;
          };
        }) => {
          const where = args.where ?? {};
          const data = args.data ?? {};

          if (where.id && where.id !== row.id) {
            return { count: 0 };
          }
          if (where.status !== undefined && where.status !== row.status) {
            return { count: 0 };
          }
          if (where.claimToken !== undefined && where.claimToken !== row.claimToken) {
            return { count: 0 };
          }
          if (where.nextAttemptAt?.lte && !(row.nextAttemptAt <= where.nextAttemptAt.lte)) {
            return { count: 0 };
          }
          if (where.leaseExpiresAt?.lte && !(row.leaseExpiresAt && row.leaseExpiresAt <= where.leaseExpiresAt.lte)) {
            return { count: 0 };
          }
          if (where.OR) {
            const matches = where.OR.some((branch) => {
              const b = branch as { status?: unknown; leaseExpiresAt?: unknown; OR?: Array<{ leaseExpiresAt?: unknown }> };
              if (typeof b.status === "string" && b.status !== row.status) {
                return false;
              }
              if (b.OR?.length) {
                return b.OR.some((sub) => {
                  if ("leaseExpiresAt" in sub && sub.leaseExpiresAt === null) {
                    return row.leaseExpiresAt === null;
                  }
                  if (sub.leaseExpiresAt && typeof sub.leaseExpiresAt === "object" && "lte" in sub.leaseExpiresAt) {
                    return row.leaseExpiresAt !== null && row.leaseExpiresAt <= (sub.leaseExpiresAt as { lte: Date }).lte;
                  }
                  return false;
                });
              }
              return true;
            });
            if (!matches) {
              return { count: 0 };
            }
          }

          if (typeof data.status === "string") {
            row.status = data.status;
          }
          if (data.attempts && typeof data.attempts === "object") {
            if ("increment" in data.attempts && data.attempts.increment) {
              row.attempts += data.attempts.increment;
            }
            if ("set" in data.attempts && data.attempts.set !== undefined) {
              row.attempts = data.attempts.set;
            }
          }
          if ("claimToken" in data) {
            row.claimToken = data.claimToken ?? null;
          }
          if ("leaseExpiresAt" in data) {
            row.leaseExpiresAt = data.leaseExpiresAt ?? null;
          }
          if (data.nextAttemptAt) {
            row.nextAttemptAt = data.nextAttemptAt;
          }
          if ("responseCode" in data) {
            row.responseCode = data.responseCode ?? null;
          }
          if ("lastError" in data) {
            row.lastError = data.lastError ?? null;
          }
          return { count: 1 };
        },
      );
      return { row, updateMany };
    }

    function wireStatefulDelivery(
      prisma: ReturnType<typeof createPrismaMock>,
      store: ReturnType<typeof exclusiveDeliveryStore>,
      secret = "whsec_test_secret",
    ) {
      prisma.webhookDelivery.updateMany.mockImplementation(store.updateMany as never);
      prisma.webhookDelivery.findUnique.mockImplementation(async () => ({
        ...store.row,
        event: "task.created",
        payload: {},
        webhook: webhookRowFor(secret),
      }));
    }

    it("two concurrent claims: exactly one wins and POSTs, the loser skips without fetching", async () => {
      const prisma = createPrismaMock();
      const store = exclusiveDeliveryStore();
      wireStatefulDelivery(prisma, store);
      stubCreatorAccess(prisma);

      const { transport, requests } = recordingTransport();

      const [winner, loser] = (await Promise.all([
        deliverWebhook(prisma as never, "delivery-1", { transport }),
        deliverWebhook(prisma as never, "delivery-1", { transport }),
      ])) as Array<{ status: string; error?: string }>;

      const succeeded = [winner, loser].filter((r) => r.status === "success");
      const skipped = [winner, loser].filter((r) => r.status === "skipped");
      expect(succeeded).toHaveLength(1);
      expect(skipped).toHaveLength(1);
      expect(skipped[0]!.error).toMatch(/claimed by another worker/i);

      // Exactly one POST happened — no double-delivery.
      expect(requests).toHaveLength(1);
      // The claim consumed exactly one attempt, minted an owner token, and the
      // row finalized as success.
      expect(store.row.status).toBe("success");
      expect(store.row.attempts).toBe(1);
      expect(store.row.claimToken).toBeTypeOf("string");
    });

    it("claims with the atomic processing predicate (pending + due), a lease from the ACTUAL claim instant, and a fresh claim token", async () => {
      // The lease must be stamped from the moment of the claim UPDATE (with
      // fake timers frozen at `now`, the claim's `new Date()` IS `now` — but
      // the stamp flows from the claim instant, not `options.now`, which the
      // per-claim lease test below proves with advancing time).
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const prisma = createPrismaMock();
      prisma.webhookDelivery.findUnique.mockResolvedValue(pendingDeliveryRow(webhookRowFor("whsec_x")));
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      stubCreatorAccess(prisma);
      const { transport } = recordingTransport();

      await deliverWebhook(prisma as never, "delivery-1", { now, transport });

      const claimCall = prisma.webhookDelivery.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(claimCall.where).toEqual({ id: "delivery-1", status: "pending", nextAttemptAt: { lte: now } });
      expect(claimCall.data.status).toBe("processing");
      expect(claimCall.data.attempts).toEqual({ increment: 1 });
      // Lease window = claim instant + configured (floored) lease.
      expect(claimCall.data.leaseExpiresAt).toEqual(new Date(now.getTime() + webhookDeliveryLeaseMs()));
      // The claim stamps the OWNER token used by every later update.
      expect(claimCall.data.claimToken).toEqual(expect.any(String));

      // Success finalization guards on the processing state AND the claim's
      // own token, not just on pending.
      const finalizeCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(finalizeCall.where).toEqual({
        id: "delivery-1",
        status: "processing",
        claimToken: claimCall.data.claimToken,
      });
      expect(finalizeCall.data.leaseExpiresAt).toBeNull();
    });
  });

  describe("claim lease timing (wave-8 finding 1: lease must cover the real POST window)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    /**
     * Finds the claim update (pending -> processing with a lease) among the
     * updateMany calls and returns the stamped lease deadline.
     */
    function claimLeases(prisma: ReturnType<typeof createPrismaMock>): Date[] {
      return (prisma.webhookDelivery.updateMany.mock.calls as unknown as Array<
        [{ where: Record<string, unknown>; data: Record<string, unknown> }]
      >)
        .filter(([args]) => args.where.status === "pending" && args.data.leaseExpiresAt instanceof Date)
        .map(([args]) => args.data.leaseExpiresAt as Date);
    }

    it("POSTs with the SAME configured timeout the lease floor derives from (single source of truth)", async () => {
      // Clamp WEBHOOK_TIMEOUT_MS to its 1s minimum. The lease floor derives
      // from the clamped ENV value (1s + preflight); if the POST ran on the
      // frozen 10s constant instead, the lease would expire while the request
      // was still live.
      vi.stubEnv("WEBHOOK_TIMEOUT_MS", "1000");
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(pendingDeliveryRow(webhookRowFor("whsec_x")));

      const { transport, requests } = recordingTransport();
      const result = await deliverWebhook(prisma as never, "delivery-1", { now, transport });

      expect(result.status).toBe("success");
      expect(requests).toHaveLength(1);
      // The production POST budget is the CLAMPED env value — never the
      // constant. Reverting to `?? WEBHOOK_TIMEOUT_MS` fails this (10000 ≠ 1000).
      expect(requests[0].timeoutMs).toBe(webhookRequestTimeoutMs());
      expect(requests[0].timeoutMs).toBe(1_000);
    });

    it("the claim lease covers preflight + the real POST window end-to-end", async () => {
      vi.stubEnv("WEBHOOK_TIMEOUT_MS", "1000");
      vi.stubEnv("WEBHOOK_DELIVERY_LEASE_MS", "1000"); // floor kicks in
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(pendingDeliveryRow(webhookRowFor("whsec_x")));

      const { transport, requests } = recordingTransport();
      await deliverWebhook(prisma as never, "delivery-1", { now, transport });

      const leaseExpiresAt = claimLeases(prisma)[0];
      expect(leaseExpiresAt).toBeInstanceOf(Date);
      // Lease window measured from the claim instant (fake-timer time at claim).
      const leaseWindowMs = leaseExpiresAt.getTime() - now.getTime();
      const actualPostTimeoutMs = requests[0].timeoutMs;
      // Lease >= one worst-case send cycle: preflight deadline + the REAL
      // POST timeout that is about to run — measured end-to-end, not assumed.
      expect(leaseWindowMs).toBeGreaterThanOrEqual(webhookDeliveryPreflightDeadlineMs() + actualPostTimeoutMs);
      // Guard against a degenerate mutation that shortens both sides:
      // the actual POST timeout equals the configured one.
      expect(actualPostTimeoutMs).toBe(webhookRequestTimeoutMs());
    });

    it("a sequential sweep stamps each row's lease from ITS OWN claim time (not the batch start)", async () => {
      const batchStart = new Date("2026-01-01T00:00:00.000Z");
      const INTER_ROW_DELAY_MS = 5_000;
      vi.setSystemTime(batchStart);
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findMany.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
      prisma.webhookDelivery.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
        pendingDeliveryRow(webhookRowFor("whsec_x"), { id: args.where.id }),
      );

      let requestsSeen = 0;
      const transport = vi.fn(async (): Promise<WebhookOutboundResponse> => {
        requestsSeen += 1;
        if (requestsSeen === 1) {
          // Simulate the sweep taking 5s between the first row's POST and the
          // second row's claim (fake wall clock advances).
          vi.setSystemTime(new Date(batchStart.getTime() + INTER_ROW_DELAY_MS));
        }
        return { status: 200, error: null };
      });

      const result = await processDueWebhookDeliveries(prisma as never, new Date(), { transport });
      expect(result.processed).toBe(2);
      expect(requestsSeen).toBe(2);

      const leases = claimLeases(prisma);
      expect(leases).toHaveLength(2);
      const leaseWindowMs = webhookDeliveryLeaseMs();
      // Row 1 was claimed at the batch start…
      expect(leases[0].getTime()).toBe(batchStart.getTime() + leaseWindowMs);
      // …and row 2 was claimed ~5s later, so ITS lease must start later too —
      // a lease derived from the shared batch timestamp would already be 5s
      // (of POST/read/preflight) consumed before the row was even claimed.
      expect(leases[1].getTime()).toBe(batchStart.getTime() + INTER_ROW_DELAY_MS + leaseWindowMs);
      expect(leases[1].getTime() - leases[0].getTime()).toBe(INTER_ROW_DELAY_MS);
    });
  });

  describe("claim lease RENEWAL before the POST (wave-9 finding 1)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    /**
     * Finds the lease-RENEWAL update among the updateMany calls. Only the
     * renewal has `status: "processing"` + a claim token in the where clause
     * AND a non-null Date lease in the data (the claim stamps
     * `status: "pending"`; the finalizes carry a non-lease `status` change
     * and null out the lease).
     */
    function leaseRenewals(prisma: ReturnType<typeof createPrismaMock>) {
      return (prisma.webhookDelivery.updateMany.mock.calls as unknown as Array<[
        { where: Record<string, unknown>; data: Record<string, unknown> },
      ]>)
        .map(([args], index) => ({ args, index }))
        .filter(
          ({ args }) =>
            args.where.status === "processing"
            && args.where.claimToken !== undefined
            && args.data.leaseExpiresAt instanceof Date
            && args.data.status === undefined,
        );
    }

    /** Creator-access stub whose lookup itself burns `delayMs` of fake time (slow claim round-trip + authz read). */

    /** Creator-access stub whose lookup itself burns `delayMs` of fake time (slow claim round-trip + authz read). */
    function stubSlowCreatorAccess(prisma: ReturnType<typeof createPrismaMock>, delayMs: number) {
      prisma.user.findUnique.mockImplementation(async (args?: { where?: { id?: string }; select?: Record<string, unknown> }) => {
        if (args?.select && "projectMemberships" in args.select) {
          vi.advanceTimersByTime(delayMs);
          return {
            id: "creator-1",
            role: "manager",
            disabledAt: null,
            projectMemberships: [{ role: "manager" }],
            projectPermissionGrants: [],
            groupMemberships: [],
          };
        }
        return { id: args?.where?.id ?? "creator-1", name: "Actor One" };
      });
    }

    it("renews the lease immediately before the POST under the claim token, covering the full POST window after slow pre-stages", async () => {
      const claimInstant = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(claimInstant);
      // The pre-POST stages (claim round-trip, authz query, decrypt, DNS
      // preflight) consume FAR more fake time than the static floored lease
      // (preflight 15s + POST 10s = 25s) can cover.
      const SLOW_STAGES_MS = 90_000;
      const prisma = createPrismaMock();
      stubSlowCreatorAccess(prisma, SLOW_STAGES_MS);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(pendingDeliveryRow(webhookRowFor("whsec_x")));

      const { transport, requests } = recordingTransport();
      const result = await deliverWebhook(prisma as never, "delivery-1", { now: claimInstant, transport });

      // The delivery still went out...
      expect(result.status).toBe("success");
      expect(requests).toHaveLength(1);

      // ...but only after a TOKEN-GATED lease renewal re-stamped the lease:
      const renewals = leaseRenewals(prisma);
      expect(renewals).toHaveLength(1);
      const [{ args: renewal, index: renewalIndex }] = renewals;
      expect(renewal.where).toEqual({
        id: "delivery-1",
        status: "processing",
        claimToken: expect.any(String),
      });
      // The renewal lease = ITS OWN instant + the full POST timeout + margin
      // — NOT the claim instant. It therefore still covers the POST even
      // though the initial claim-time lease (claim + 25s floor) expired at
      // least 65s worth of stages ago.
      expect((renewal.data.leaseExpiresAt as Date).getTime()).toBe(
        claimInstant.getTime() + SLOW_STAGES_MS + webhookRequestTimeoutMs() + webhookLeaseMarginMs(),
      );
      // The renewal ran BEFORE the POST (it guards exactly the POST window).
      expect(prisma.webhookDelivery.updateMany.mock.invocationCallOrder[renewalIndex]).toBeLessThan(
        transport.mock.invocationCallOrder[0],
      );
    });

    it("aborts WITHOUT POSTING when the claim token no longer matches at renewal time (claim lost mid-pipeline)", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      // The claim succeeds; every later token-gated update matches 0 rows —
      // the model of lease expiry + recovery + a second worker's re-claim.
      prisma.webhookDelivery.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValue({ count: 0 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(pendingDeliveryRow(webhookRowFor("whsec_x")));
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport } = recordingTransport(() => {
        throw new Error("must never POST after losing the claim to another worker");
      });

      const result = await deliverWebhook(prisma as never, "delivery-1", { now, transport });

      // Skipped WITHOUT a POST and WITHOUT any finalize/requeue write (we no
      // longer own the row — a second worker's claim must not be clobbered).
      expect(transport).not.toHaveBeenCalled();
      expect(result.status).toBe("skipped");
      expect(result.error).toMatch(/claim was lost/i);
      // Exactly two writes: the claim, then the rejected renewal.
      expect(prisma.webhookDelivery.updateMany).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("lease renewal rejected before the POST"));
    });

    it("bounds the send-time authz query and fails closed on deadline (no POST, no unbounded stall)", async () => {
      vi.stubEnv("WEBHOOK_PREFLIGHT_BUDGET_MS", "1000");
      const now = new Date("2026-01-01T00:00:00.000Z");
      vi.setSystemTime(now);
      const prisma = createPrismaMock();
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(pendingDeliveryRow(webhookRowFor("whsec_x")));
      // A stalled/stuck DB: the authz lookup NEVER resolves. Without the
      // deadline the worker would hang forever holding its claim.
      prisma.user.findUnique.mockImplementation(() => new Promise(() => {}));

      const { transport } = recordingTransport(() => {
        throw new Error("must never POST after a failed (timed-out) authorization");
      });
      const resultPromise = deliverWebhook(prisma as never, "delivery-1", { now, transport });
      // Run the fake clock past the 1s authz deadline.
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      // Fail closed: no POST, no unbounded stall, and the claim is handed
      // back through the bounded retry ladder (attempt 1 of 3 → retryable).
      expect(transport).not.toHaveBeenCalled();
      expect(result.status).toBe("pending");
      expect(result.error).toMatch(/Webhook creator access re-check exceeded the 1s deadline/i);
      const failureCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(failureCall.where).toEqual({ id: "delivery-1", status: "processing", claimToken: expect.any(String) });
      expect(failureCall.data.status).toBe("pending");
      expect(failureCall.data.nextAttemptAt).toEqual(new Date(now.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]));
    });
  });

  describe("deliverWebhook", () => {
    it("POSTs a correctly signed request and marks the delivery successful", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const payload = { event: "task.created", occurredAt: now.toISOString(), task: { id: "t1" } };

      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(
        pendingDeliveryRow(webhookRowFor(secret), { payload }),
      );

      const { transport, requests } = recordingTransport();

      const result = await deliverWebhook(prisma as never, "delivery-1", { now, transport });

      expect(result).toEqual({ status: "success", responseCode: 200 });
      expect(requests).toHaveLength(1);
      const request = requests[0];
      expect(request.url).toBe(PUBLIC_URL);
      expect(request.headers["x-taskito-event"]).toBe("task.created");
      expect(request.headers["x-taskito-delivery"]).toBe("delivery-1");
      const timestamp = request.headers["x-taskito-timestamp"];
      expect(timestamp).toBe(Math.floor(now.getTime() / 1000).toString());

      const expectedBody = JSON.stringify({ ...payload, id: "delivery-1" });
      expect(request.body).toBe(expectedBody);
      const expectedSignature = computeWebhookSignature(secret, timestamp, expectedBody);
      expect(request.headers["x-taskito-signature"]).toBe(`sha256=${expectedSignature}`);

      const successCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };
      expect(successCall.data.status).toBe("success");
      expect(successCall.data.responseCode).toBe(200);
    });

    it("refuses a delivery whose URL now resolves to a private address, without sending (mutation-provable)", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(
        pendingDeliveryRow(webhookRowFor("whsec_x", { url: "http://127.0.0.1:9000/hook" })),
      );

      const { transport } = recordingTransport(() => {
        throw new Error("delivery must not be sent to a private target");
      });

      const result = await deliverWebhook(prisma as never, "delivery-1", { now });
      expect(transport).not.toHaveBeenCalled();
      expect(result.status).toBe("pending");
      expect(result.error).toMatch(/private, loopback, or link-local/);

      const failureCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(failureCall.data.nextAttemptAt).toEqual(new Date(now.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]));
      // A non-exhausted failure hands the OWNED claim back to pending so the
      // sweep re-delivers (the row must never stay processing).
      expect(failureCall.data.status).toBe("pending");
      expect(failureCall.where).toEqual({
        id: "delivery-1",
        status: "processing",
        claimToken: expect.any(String),
      });
    });

    it("refuses a hostname whose resolved answers include ANY private record (all A/AAAA validated)", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(
        pendingDeliveryRow(webhookRowFor("whsec_x", { url: "http://mixed.attacker.example:8080/hook" })),
      );

      // One public answer and one private answer: the whole record set must fail.
      dnsLookupMock.mockResolvedValue([
        { address: "93.184.216.34", family: 4 },
        { address: "10.1.2.3", family: 4 },
      ]);

      const { transport } = recordingTransport(() => {
        throw new Error("must never connect when any answer is private");
      });

      const result = await deliverWebhook(prisma as never, "delivery-1", { now });
      expect(transport).not.toHaveBeenCalled();
      expect(result.status).toBe("pending");
      expect(result.error).toMatch(/private, loopback, or link-local/);
      expect(dnsLookupMock).toHaveBeenCalledTimes(1);
    });

    it("pins the send-time connection to the validated DNS answer (DNS-rebinding TOCTOU, mutation-provable)", async () => {
      const REBIND_HOST = "rebind.attacker.example";
      const PUBLIC_IP = "93.184.216.34";
      const now = new Date("2026-01-01T00:00:00.000Z");
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(
        pendingDeliveryRow(webhookRowFor("whsec_x", { url: `http://${REBIND_HOST}:8080/hook` })),
      );

      // Validation-time resolution: PUBLIC. Every later resolution — what a
      // re-resolving fetch would see at connect time — returns the cloud
      // metadata endpoint (rebinding world).
      dnsLookupMock.mockImplementation(async (hostname: string) => {
        if (hostname === REBIND_HOST) {
          return [{ address: PUBLIC_IP, family: 4 }];
        }
        throw new Error(`unexpected DNS lookup for ${hostname}`);
      });

      let capturedRequest: WebhookOutboundRequest | null = null;
      const { transport } = recordingTransport((request) => {
        capturedRequest = request;
        return { status: 200, error: null };
      });

      const options: DeliverWebhookOptions = { now, transport };
      const result = await deliverWebhook(prisma as never, "delivery-1", options);
      expect(result.status).toBe("success");
      expect(transport).toHaveBeenCalledTimes(1);

      // The dispatcher handed the transport a pinned lookup.
      expect(capturedRequest).not.toBeNull();
      const pinned = capturedRequest as unknown as WebhookOutboundRequest;
      expect(pinned.lookup).toBeTypeOf("function");
      // The original hostname (SNI + Host) is preserved — only the IP is pinned.
      expect(pinned.url).toBe(`http://${REBIND_HOST}:8080/hook`);

      // Now flip DNS to the metadata endpoint: the pinned lookup must STILL
      // return the validated public address — the connection never re-resolves.
      dnsLookupMock.mockImplementation(async () => [{ address: "169.254.169.254", family: 4 }]);
      const allAnswers = await invokePinnedLookup(pinned.lookup as NonNullable<WebhookOutboundRequest["lookup"]>, { all: true });
      expect(allAnswers).toEqual([{ address: PUBLIC_IP, family: 4 }]);
      const singleAnswer = await invokePinnedLookup(pinned.lookup as NonNullable<WebhookOutboundRequest["lookup"]>);
      expect(singleAnswer).toEqual({ address: PUBLIC_IP, family: 4 });
    });

    it("allows a private-address delivery when WEBHOOK_ALLOW_PRIVATE_HOSTS=true", async () => {
      vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_HOSTS", "true");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(
        pendingDeliveryRow(webhookRowFor(secret, { url: "http://127.0.0.1:9000/hook" })),
      );

      const { transport, requests } = recordingTransport();

      const result = await deliverWebhook(prisma as never, "delivery-1", { now, transport });
      expect(result.status).toBe("success");
      expect(transport).toHaveBeenCalledTimes(1);
      // No pin applies for opted-in private targets: the transport may resolve normally.
      expect(requests[0].lookup).toBeUndefined();
    });

    it("marks a 3xx redirect response as a failure (redirects are never followed)", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(pendingDeliveryRow(webhookRowFor("whsec_x")));

      const { transport, requests } = recordingTransport(() => ({ status: 302, error: null }));
      const result = await deliverWebhook(prisma as never, "delivery-1", { now, transport });

      expect(requests).toHaveLength(1);
      expect(result.status).toBe("pending");
      expect(result.responseCode).toBe(302);
      expect(result.error).toMatch(/HTTP status 302/);
      expect(transport).toHaveBeenCalledTimes(1);
    });

    it("finalizes as failed when the secret can no longer be decrypted (post-rotation, capped)", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue(
        pendingDeliveryRow(
          webhookRowFor("whsec_x", {
            // Ciphertext that decrypts cleanly under NO configured key: what a
            // master-key cutover without re-encryption produces.
            encryptedSecret: "v1:c2hvcnRjaXBoZXJ0ZXh0",
          }),
          { attempts: WEBHOOK_MAX_ATTEMPTS - 1 },
        ),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport } = recordingTransport(() => {
        throw new Error("must not POST when the secret cannot be decrypted");
      });

      const result = await deliverWebhook(prisma as never, "delivery-1", { now, transport });

      expect(transport).not.toHaveBeenCalled();
      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/could not be decrypted/);

      const failureCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(failureCall.where).toEqual({ id: "delivery-1", status: "processing", claimToken: expect.any(String) });
      expect(failureCall.data.status).toBe("failed");
      expect(failureCall.data.attempts).toEqual({ set: WEBHOOK_MAX_ATTEMPTS });
      // No further retry is scheduled: the row stops churning at the cap.
      expect(failureCall.data.nextAttemptAt).toEqual(now);
      expect(failureCall.data.leaseExpiresAt).toBeNull();
    });

    it("schedules 1m then 5m backoff and marks failed after WEBHOOK_MAX_ATTEMPTS", async () => {
      expect(WEBHOOK_MAX_ATTEMPTS).toBe(3);
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });

      const { transport, requests } = recordingTransport(() => ({ status: 500, error: null }));

      for (let attemptIndex = 0; attemptIndex < WEBHOOK_MAX_ATTEMPTS; attemptIndex += 1) {
        prisma.webhookDelivery.findUnique.mockResolvedValueOnce(
          pendingDeliveryRow(webhookRowFor(secret), { attempts: attemptIndex }),
        );

        const result = await deliverWebhook(prisma as never, "delivery-1", { now, transport });
        const failureCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        };
        const attempts = attemptIndex + 1;

        if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
          expect(result.status).toBe("failed");
          expect(failureCall.data.status).toBe("failed");
          expect(failureCall.data.nextAttemptAt).toEqual(now);
        } else {
          expect(result.status).toBe("pending");
          // Non-exhausted failures RE-QUEUE the owned claim as pending so the
          // sweep picks it up (never stuck in processing).
          expect(failureCall.data.status).toBe("pending");
          expect(failureCall.where).toEqual({
            id: "delivery-1",
            status: "processing",
            claimToken: expect.any(String),
          });
          const expectedDelay = WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
          expect(failureCall.data.nextAttemptAt).toEqual(new Date(now.getTime() + expectedDelay));
        }
        expect(failureCall.data.attempts).toEqual({ set: attempts });
        expect(failureCall.data.leaseExpiresAt).toBeNull();
      }

      expect(transport).toHaveBeenCalledTimes(WEBHOOK_MAX_ATTEMPTS);
      expect(requests).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    });
  });

  describe("processDueWebhookDeliveries", () => {
    it("recovers expired processing leases, then sweeps due pending deliveries", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.findMany.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockImplementation(async (args: { where: { id: string } }) =>
        pendingDeliveryRow(webhookRowFor(secret), { id: args.where.id }),
      );
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const { transport, requests } = recordingTransport();
      const result = await processDueWebhookDeliveries(prisma as never, now, { transport });

      // Recovery: expired processing rows are deliberately handed back to pending.
      const recoveryCall = prisma.webhookDelivery.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(recoveryCall.where).toEqual({ status: "processing", leaseExpiresAt: { lte: now } });
      expect(recoveryCall.data).toEqual({ status: "pending", nextAttemptAt: now, leaseExpiresAt: null, claimToken: null });

      expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "pending",
            nextAttemptAt: { lte: now },
            webhook: { isEnabled: true },
          }),
        }),
      );
      expect(result).toEqual({ processed: 2, succeeded: 2 });
      expect(transport).toHaveBeenCalledTimes(2);
      expect(requests).toHaveLength(2);
    });

    it("keeps sweeping even when deliverWebhook throws for one row", async () => {
      const prisma = createPrismaMock();
      stubCreatorAccess(prisma);
      prisma.webhookDelivery.findMany.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
      prisma.webhookDelivery.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
        if (args.where.id === "d1") {
          throw new Error("boom");
        }
        return pendingDeliveryRow(webhookRowFor("whsec_x"), { id: "d2" });
      });
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });

      const { transport } = recordingTransport();
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = await processDueWebhookDeliveries(prisma as never, new Date(), { transport });
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(1);
      expect(transport).toHaveBeenCalledTimes(1);
    });
  });

  describe("sendWebhookPing", () => {
    it("sends a signed ping and reports success", async () => {
      const secret = "whsec_ping_secret";
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });

      const { transport, requests } = recordingTransport();

      const result = await sendWebhookPing(prisma as never, {
        webhookId: "wh1",
        url: PUBLIC_URL,
        encryptedSecret: encryptSecret(secret),
        projectId: "p1",
        transport,
      });

      expect(result).toEqual({ status: "success", responseCode: 200, error: null });
      expect(requests[0].headers["x-taskito-event"]).toBe("ping");
    });

    it("rejects a private ping target before sending anything", async () => {
      const prisma = createPrismaMock();
      const { transport } = recordingTransport(() => {
        throw new Error("must not be called");
      });

      const result = await sendWebhookPing(prisma as never, {
        webhookId: "wh1",
        url: "http://10.0.0.5/hook",
        encryptedSecret: encryptSecret("whsec_x"),
        projectId: "p1",
        transport,
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/private, loopback, or link-local/);
      expect(transport).not.toHaveBeenCalled();
    });
  });

  describe("defaultWebhookTransport (Node transport)", () => {
    let servers: http.Server[] = [];

    afterEach(async () => {
      await Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve) => {
              server.close(() => resolve());
            }),
        ),
      );
      servers = [];
    });

    function listenOnLoopback(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<number> {
      const server = http.createServer(handler);
      servers.push(server);
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
      });
    }

    function pinnedLookupToLoopback(hostname: string, port: number) {
      const url = `http://${hostname}:${port}/hook`;
      return createPinnedOutboundLookup({ url, hostname, pinned: { address: "127.0.0.1", family: 4 } });
    }

    it("connects to the pinned address while preserving the original Host header", async () => {
      const seen: { host: string | undefined; url: string | undefined; body: string } = { host: undefined, url: undefined, body: "" };
      const port = await listenOnLoopback((req, res) => {
        seen.host = req.headers.host;
        seen.url = req.url;
        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString("utf8");
        });
        req.on("end", () => {
          seen.body = raw;
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok":true}');
        });
      });

      const HOSTNAME = "rebinding-hostname.invalid";
      const result = await defaultWebhookTransport({
        url: `http://${HOSTNAME}:${port}/hook`,
        headers: { "content-type": "application/json", "x-taskito-event": "ping" },
        body: JSON.stringify({ hello: "world" }),
        timeoutMs: 5_000,
        // Connect-time "DNS" says loopback (simulating the validated answer),
        // while the URL hostname is intentionally unresolvable — only the
        // pinned lookup can get us there.
        lookup: pinnedLookupToLoopback(HOSTNAME, port),
      });

      expect(result).toEqual({ status: 200, error: null });
      // The connection reached the loopback server THROUGH the pinned lookup
      // (the hostname itself can never resolve), with the original Host.
      expect(seen.host).toBe(`${HOSTNAME}:${port}`);
      expect(seen.url).toBe("/hook");
      expect(JSON.parse(seen.body)).toEqual({ hello: "world" });
    });

    it("destroys responses larger than the cap instead of draining them", async () => {
      const TOTAL_BYTES = 4 * 1024 * 1024;
      const CHUNK = 32 * 1024;
      let serverFinished = false;
      let serverWroteBytes = 0;

      const port = await listenOnLoopback((req, res) => {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const step = () => {
          if (serverFinished) {
            return;
          }
          if (serverWroteBytes >= TOTAL_BYTES) {
            serverFinished = true;
            res.end();
            return;
          }
          serverWroteBytes += CHUNK;
          res.write(Buffer.alloc(CHUNK, 0x61), () => setImmediate(step));
        };
        step();
        res.on("close", () => {
          serverFinished = true;
        });
        res.on("error", () => {
          serverFinished = true;
        });
      });

      const result = await defaultWebhookTransport({
        url: `http://127.0.0.1:${port}/huge`,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ok: 1 }),
        timeoutMs: 10_000,
      });

      // Status was captured even though the body was truncated at the cap.
      expect(result.status).toBe(200);
      // The transport resolved while the server was STILL streaming the 4MB
      // body — it did not wait for (or buffer) the whole payload.
      expect(serverFinished).toBe(false);
      expect(serverWroteBytes).toBeLessThan(TOTAL_BYTES);
    });

    it("reports a timeout error when the target never answers", async () => {
      const port = await listenOnLoopback(() => {
        // Never respond.
      });

      const result = await defaultWebhookTransport({
        url: `http://127.0.0.1:${port}/hang`,
        headers: { "content-type": "application/json" },
        body: "{}",
        timeoutMs: 50,
      });

      expect(result.status).toBeNull();
      expect(result.error).toMatch(/timed out after 1 seconds/);
    });
  });
});