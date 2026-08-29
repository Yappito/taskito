import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// NOTE: authz is intentionally NOT mocked — this suite pins the real
// authorization behavior of the webhook router (same "Pattern A" approach as
// task-router-authz.test.ts).
import { webhookRouter } from "@/server/routers/webhook";
import { callerFor, memberOf } from "@/test/actors";

const PROJECT_A = "cmab8yxxp0001a0p0r0j0e0c0t0a0a0";
const PROJECT_B = "cmab8yxxp0002b0p0r0j0e0c0t0b0b0";
const WEBHOOK_IN_B = "cmab8yxxp0003w0e0b0h0o0o0k0b0b0";
const DELIVERY_IN_B = "cmab8yxxp0004d0e0l0i0v0e0r0y0b0";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
// Public IP literal so URL validation never needs real DNS in this offline sandbox.
const PUBLIC_URL = "https://93.184.216.34/taskito";

function webhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WEBHOOK_IN_B,
    projectId: PROJECT_B,
    url: "https://hooks.example.com/taskito",
    encryptedSecret: "v1:irrelevant-for-authz-tests",
    events: ["task.created"],
    isEnabled: true,
    createdByUserId: "someone-else",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("webhook router authorization", () => {
  beforeEach(() => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("member without automation_manage", () => {
    it("list is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.list({ projectId: PROJECT_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("create is FORBIDDEN and performs no write", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(
        caller.create({ projectId: PROJECT_A, url: "https://hooks.example.com/x", events: ["task.created"] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.create).not.toHaveBeenCalled();
    });

    it("update is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
      actor.prisma.webhook.findUnique.mockResolvedValue({ id: WEBHOOK_IN_B, projectId: PROJECT_A });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.update({ id: WEBHOOK_IN_B, isEnabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.update).not.toHaveBeenCalled();
    });

    it("delete is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
      actor.prisma.webhook.findUnique.mockResolvedValue({ id: WEBHOOK_IN_B, projectId: PROJECT_A });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.delete({ id: WEBHOOK_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.delete).not.toHaveBeenCalled();
    });

    it("testDelivery is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
      actor.prisma.webhook.findUnique.mockResolvedValue(webhookRow({ projectId: PROJECT_A }));
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.testDelivery({ id: WEBHOOK_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("listDeliveries is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.listDeliveries({ projectId: PROJECT_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("redeliver is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
      actor.prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: DELIVERY_IN_B,
        status: "failed",
        webhook: { projectId: PROJECT_A, isEnabled: true },
      });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.redeliver({ id: DELIVERY_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("cross-project webhook id", () => {
    it("update on a webhook in another project is FORBIDDEN", async () => {
      // Manager of project A only; the webhook actually belongs to project B.
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhook.findUnique.mockResolvedValue(webhookRow());
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.update({ id: WEBHOOK_IN_B, isEnabled: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.update).not.toHaveBeenCalled();
    });

    it("delete on a webhook in another project is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhook.findUnique.mockResolvedValue(webhookRow());
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.delete({ id: WEBHOOK_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("a nonexistent webhook id is NOT_FOUND", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhook.findUnique.mockResolvedValue(null);
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.update({ id: WEBHOOK_IN_B, isEnabled: false })).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("redeliver on a delivery in another project is FORBIDDEN", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: DELIVERY_IN_B,
        status: "failed",
        webhook: { projectId: PROJECT_B, isEnabled: true },
      });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.redeliver({ id: DELIVERY_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("member with automation_manage but task_read denied (finding 8)", () => {
    function denyTaskReadActor() {
      // Manager-level automation access, but the tenant explicitly DENIED
      // task read. Webhook endpoints receive task metadata, so this principal
      // must not be able to register/enforce-delivery to one either.
      return memberOf({
        userId: "user-1",
        projects: { [PROJECT_A]: "manager" },
        grants: [{ projectId: PROJECT_A, permission: "task_read", allowed: false }],
      });
    }

    it("create is FORBIDDEN and performs no write", async () => {
      const actor = denyTaskReadActor();
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(
        caller.create({ projectId: PROJECT_A, url: PUBLIC_URL, events: ["task.created"] }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.create).not.toHaveBeenCalled();
    });

    it("update (enable) is FORBIDDEN", async () => {
      const actor = denyTaskReadActor();
      actor.prisma.webhook.findUnique.mockResolvedValue(webhookRow({ projectId: PROJECT_A }));
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.update({ id: WEBHOOK_IN_B, isEnabled: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.update).not.toHaveBeenCalled();
    });

    it("delete is FORBIDDEN", async () => {
      const actor = denyTaskReadActor();
      actor.prisma.webhook.findUnique.mockResolvedValue(webhookRow({ projectId: PROJECT_A }));
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.delete({ id: WEBHOOK_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.delete).not.toHaveBeenCalled();
    });

    it("testDelivery is FORBIDDEN and sends nothing", async () => {
      const actor = denyTaskReadActor();
      actor.prisma.webhook.findUnique.mockResolvedValue(webhookRow({ projectId: PROJECT_A }));
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.testDelivery({ id: WEBHOOK_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.delete).not.toHaveBeenCalled();
    });

    it("list is FORBIDDEN (endpoint config + creator identity need task_read too)", async () => {
      const actor = denyTaskReadActor();
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.list({ projectId: PROJECT_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhook.findMany).not.toHaveBeenCalled();
    });

    it("listDeliveries is FORBIDDEN (delivery history needs task_read too)", async () => {
      const actor = denyTaskReadActor();
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.listDeliveries({ projectId: PROJECT_A })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
    });

    it("redeliver is FORBIDDEN and performs no write", async () => {
      const actor = denyTaskReadActor();
      actor.prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: DELIVERY_IN_B,
        status: "failed",
        leaseExpiresAt: null,
        webhook: { projectId: PROJECT_A, isEnabled: true },
      });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      await expect(caller.redeliver({ id: DELIVERY_IN_B })).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(actor.prisma.webhookDelivery.updateMany).not.toHaveBeenCalled();
      expect(actor.prisma.webhookDelivery.update).not.toHaveBeenCalled();
    });
  });

  describe("redeliver vs active claims (claim-token lease, wave-6 finding 2)", () => {
    it("refuses to disrupt an unexpired processing claim (no requeue, no duplicate POST)", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: DELIVERY_IN_B,
        status: "processing",
        leaseExpiresAt: new Date(Date.now() + 100_000),
        webhook: { projectId: PROJECT_A, isEnabled: true },
      });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      await expect(caller.redeliver({ id: DELIVERY_IN_B })).rejects.toMatchObject({
        code: "CONFLICT",
        message: /currently being processed/i,
      });
      // No unconditional write and no duplicate fire-and-forget delivery: the
      // only write attempted is the atomically-guarded requeue, which carries
      // the not-processing/expired predicate (so even a racing claim could not
      // be clobbered into a second POST).
      expect(actor.prisma.webhookDelivery.update).not.toHaveBeenCalled();
      const attempts = actor.prisma.webhookDelivery.updateMany.mock.calls as Array<[
        { where: { OR?: unknown[] } },
      ]>;
      for (const [args] of attempts) {
        expect(args.where.OR).toBeDefined();
      }
    });

    it("requeues an EXPIRED processing claim (atomic expiry branch) and revokes the stale token", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: DELIVERY_IN_B,
        status: "processing",
        leaseExpiresAt: new Date(Date.now() - 5_000),
        webhook: { projectId: PROJECT_A, isEnabled: true },
      });
      actor.prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      const result = (await caller.redeliver({ id: DELIVERY_IN_B })) as { success: boolean };
      expect(result.success).toBe(true);

      const call = actor.prisma.webhookDelivery.updateMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      };
      expect(call.where).toMatchObject({ id: DELIVERY_IN_B });
      // The not-processing/expired branch is re-evaluated atomically at write time.
      expect(call.where.OR).toBeDefined();
      expect(call.data).toMatchObject({
        status: "pending",
        attempts: 0,
        claimToken: null,
        leaseExpiresAt: null,
      });
    });

    it("requeues a failed delivery with a fresh attempt budget", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: DELIVERY_IN_B,
        status: "failed",
        leaseExpiresAt: null,
        webhook: { projectId: PROJECT_A, isEnabled: true },
      });
      actor.prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      const result = (await caller.redeliver({ id: DELIVERY_IN_B })) as { success: boolean };
      expect(result.success).toBe(true);
      const call = actor.prisma.webhookDelivery.updateMany.mock.calls[0][0] as { data: Record<string, unknown> };
      expect(call.data.status).toBe("pending");
      expect(call.data.claimToken).toBeNull();
    });
  });

  describe("per-project webhook count cap (finding 9 + wave-6 finding 4)", () => {
    it("rejects the (N+1)th webhook with BAD_REQUEST and performs no write", async () => {
      vi.stubEnv("WEBHOOK_MAX_WEBHOOKS_PER_PROJECT", "1");
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhook.count.mockResolvedValue(1);
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      await expect(
        caller.create({ projectId: PROJECT_A, url: PUBLIC_URL, events: ["task.created"] }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /per-project limit of 1/ });
      expect(actor.prisma.webhook.create).not.toHaveBeenCalled();
    });

    it("allows creation below the cap and writes the secret under the rotation lock", async () => {
      vi.stubEnv("WEBHOOK_MAX_WEBHOOKS_PER_PROJECT", "1");
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhook.count.mockResolvedValue(0);
      actor.prisma.webhook.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: "new-webhook-id",
        url: args.data.url,
        events: args.data.events,
        isEnabled: args.data.isEnabled,
        createdByUserId: args.data.createdByUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      const result = (await caller.create({
        projectId: PROJECT_A,
        url: PUBLIC_URL,
        events: ["task.created"],
      })) as { secret: string };
      expect(result.secret.startsWith("whsec_")).toBe(true);
      // withSecretRotationLock wraps the write in a transaction.
      expect(actor.prisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it("does not trust the pre-lock count: the cap is re-read inside the rotation lock (TOCTOU)", async () => {
      vi.stubEnv("WEBHOOK_MAX_WEBHOOKS_PER_PROJECT", "5");
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      // The loose pre-lock check sees 4 (< 5) and passes, but by the time the
      // serialized critical section runs, a concurrent create pushed the
      // project to the cap — the recount under the lock must reject.
      let countCalls = 0;
      actor.prisma.webhook.count.mockImplementation(async () => (countCalls++ === 0 ? 4 : 5));
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      await expect(
        caller.create({ projectId: PROJECT_A, url: PUBLIC_URL, events: ["task.created"] }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST", message: /per-project limit of 5/ });
      expect(actor.prisma.webhook.create).not.toHaveBeenCalled();
    });

    it("concurrent creates cannot exceed the cap (count + insert enclosed by the serialized boundary)", async () => {
      vi.stubEnv("WEBHOOK_MAX_WEBHOOKS_PER_PROJECT", "3");
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });

      // Emulate the pg advisory lock: transactions run strictly serialized.
      const originalTransaction = actor.prisma.$transaction.getMockImplementation() as
        | ((input: unknown) => Promise<unknown>)
        | undefined;
      let tail: Promise<unknown> = Promise.resolve();
      actor.prisma.$transaction.mockImplementation(async (input: unknown) => {
        if (typeof input !== "function") {
          if (!originalTransaction) {
            throw new Error("original $transaction implementation unavailable");
          }
          return originalTransaction(input);
        }
        const run = tail.then(() => (input as (tx: unknown) => Promise<unknown>)(actor.prisma));
        tail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      });

      let created = 0;
      // Live count: reflects every insert that has landed so far (both the
      // pre-check and the recount-under-lock call this mock).
      actor.prisma.webhook.count.mockImplementation(async () => created);
      actor.prisma.webhook.create.mockImplementation(async () => {
        created += 1;
        return { id: `new-webhook-${created}`, createdAt: new Date(), updatedAt: new Date() };
      });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      const settled = await Promise.allSettled(
        Array.from({ length: 10 }, () =>
          caller.create({ projectId: PROJECT_A, url: PUBLIC_URL, events: ["task.created"] }),
        ),
      );

      // The cap is never exceeded, no matter how the callers interleave.
      expect(created).toBeLessThanOrEqual(3);
      const rejected = settled.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      const fulfilled = settled.filter((r) => r.status === "fulfilled");
      expect(fulfilled).toHaveLength(created);
      expect(rejected.length).toBe(10 - created);
      for (const rejection of rejected) {
        expect((rejection.reason as { code?: string }).code).toBe("BAD_REQUEST");
        expect((rejection.reason as Error).message).toMatch(/per-project limit of 3/);
      }
    });
  });

  describe("manager with automation_manage", () => {
    it("create returns the plaintext secret exactly once and never persists it", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhook.create.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
        id: "new-webhook-id",
        url: args.data.url,
        events: args.data.events,
        isEnabled: args.data.isEnabled,
        createdByUserId: args.data.createdByUserId,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
      const result = (await caller.create({
        projectId: PROJECT_A,
        url: PUBLIC_URL,
        events: ["task.created"],
      })) as { secret: string };

      expect(typeof result.secret).toBe("string");
      expect(result.secret.startsWith("whsec_")).toBe(true);

      const createCall = actor.prisma.webhook.create.mock.calls[0][0] as { data: Record<string, unknown> };
      // The plaintext secret must never be the thing written to the row.
      expect(createCall.data.encryptedSecret).not.toBe(result.secret);
      expect(String(createCall.data.encryptedSecret)).not.toContain(result.secret);
      // And it must not be echoed back on the persisted-shape select either.
      expect(Object.keys(createCall.data)).not.toContain("secret");
    });

    it("rejects a private-address URL at create and performs no write", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      await expect(
        caller.create({ projectId: PROJECT_A, url: "http://127.0.0.1:9000/hook", events: ["task.created"] }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(actor.prisma.webhook.create).not.toHaveBeenCalled();
    });

    it("rejects a private-address URL at update and performs no write", async () => {
      const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "manager" } });
      actor.prisma.webhook.findUnique.mockResolvedValue({ id: WEBHOOK_IN_B, projectId: PROJECT_A });
      const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);

      await expect(
        caller.update({ id: WEBHOOK_IN_B, url: "http://169.254.169.254/latest/meta-data" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect(actor.prisma.webhook.update).not.toHaveBeenCalled();
    });
  });
});
