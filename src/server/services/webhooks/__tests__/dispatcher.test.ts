import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptSecret } from "@/lib/secret-crypto";
import {
  buildWebhookTaskSnapshot,
  deliverWebhook,
  emitWebhookEvent,
  processDueWebhookDeliveries,
  sendWebhookPing,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from "@/server/services/webhooks/dispatcher";
import { computeWebhookSignature } from "@/server/services/webhooks/signature";
import { installFakeFetch, jsonResponse } from "@/server/services/ai/__tests__/helpers/fake-provider";
import { createPrismaMock } from "@/test/prisma-mock";

// Public IP literal (skips DNS resolution entirely — see
// `isIpLiteralHostname` in ai-provider-validation.ts) so "allowed" tests never
// touch the network in this offline sandbox.
const PUBLIC_URL = "https://93.184.216.34/hook";
const MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

function webhookRowFor(secret: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "wh1",
    url: PUBLIC_URL,
    encryptedSecret: encryptSecret(secret),
    isEnabled: true,
    ...overrides,
  };
}

describe("webhook dispatcher", () => {
  let restoreFetch: (() => void) | undefined;

  beforeEach(() => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_HOSTS", "false");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = undefined;
    }
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

  describe("emitWebhookEvent", () => {
    it("creates one delivery per enabled+subscribed webhook with a whitelisted payload", async () => {
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });
      prisma.webhook.findMany.mockResolvedValue([{ id: "wh1" }, { id: "wh2" }]);
      prisma.user.findUnique.mockResolvedValue({ id: "actor1", name: "Actor One" });
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

      const result = await emitWebhookEvent(prisma as never, {
        projectId: "p1",
        event: "task.created",
        actorId: "actor1",
        payload: { task: sensitiveTask },
      });

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
  });

  describe("deliverWebhook", () => {
    it("POSTs a correctly signed request and marks the delivery successful", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const payload = { event: "task.created", occurredAt: now.toISOString(), task: { id: "t1" } };

      const prisma = createPrismaMock();
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: "delivery-1",
        status: "pending",
        attempts: 0,
        payload,
        event: "task.created",
        webhook: webhookRowFor(secret),
      });

      const fake = installFakeFetch(() => jsonResponse({ ok: true }, 200));
      restoreFetch = fake.restore;

      const result = await deliverWebhook(prisma as never, "delivery-1", { now });

      expect(result).toEqual({ status: "success", responseCode: 200 });
      expect(fake.requests).toHaveLength(1);
      const request = fake.requests[0];
      expect(request.url).toBe(PUBLIC_URL);
      expect(request.headers["x-taskito-event"]).toBe("task.created");
      expect(request.headers["x-taskito-delivery"]).toBe("delivery-1");
      const timestamp = request.headers["x-taskito-timestamp"];
      expect(timestamp).toBe(Math.floor(now.getTime() / 1000).toString());

      const expectedBody = JSON.stringify({ ...payload, id: "delivery-1" });
      expect(request.rawBody).toBe(expectedBody);
      const expectedSignature = computeWebhookSignature(secret, timestamp, expectedBody);
      expect(request.headers["x-taskito-signature"]).toBe(`sha256=${expectedSignature}`);

      const successCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };
      expect(successCall.data.status).toBe("success");
      expect(successCall.data.responseCode).toBe(200);
    });

    it("skips a delivery already claimed by another worker, without calling fetch", async () => {
      const prisma = createPrismaMock();
      prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: "delivery-1",
        status: "pending",
        attempts: 0,
        payload: {},
        event: "task.created",
        webhook: webhookRowFor("whsec_x"),
      });
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 0 });

      const fake = installFakeFetch(() => jsonResponse({}, 200));
      restoreFetch = fake.restore;

      const result = await deliverWebhook(prisma as never, "delivery-1");
      expect(result.status).toBe("skipped");
      expect(fake.fetchMock).not.toHaveBeenCalled();
    });

    it("rejects a delivery whose URL now resolves to a private address, without calling fetch (mutation-provable)", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const prisma = createPrismaMock();
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: "delivery-1",
        status: "pending",
        attempts: 0,
        payload: {},
        event: "task.created",
        webhook: webhookRowFor("whsec_x", { url: "http://127.0.0.1:9000/hook" }),
      });

      const fake = installFakeFetch(() => {
        throw new Error("fetch must not be called for a private target");
      });
      restoreFetch = fake.restore;

      const result = await deliverWebhook(prisma as never, "delivery-1", { now });
      expect(fake.fetchMock).not.toHaveBeenCalled();
      expect(result.status).toBe("pending");
      expect(result.error).toMatch(/private, loopback, or link-local/);

      const failureCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
        data: Record<string, unknown>;
      };
      expect(failureCall.data.nextAttemptAt).toEqual(new Date(now.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]));
    });

    it("allows a private-address delivery when WEBHOOK_ALLOW_PRIVATE_HOSTS=true", async () => {
      vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_HOSTS", "true");
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const prisma = createPrismaMock();
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockResolvedValue({
        id: "delivery-1",
        status: "pending",
        attempts: 0,
        payload: { event: "task.created" },
        event: "task.created",
        webhook: webhookRowFor(secret, { url: "http://127.0.0.1:9000/hook" }),
      });

      const fake = installFakeFetch(() => jsonResponse({}, 200));
      restoreFetch = fake.restore;

      const result = await deliverWebhook(prisma as never, "delivery-1", { now });
      expect(result.status).toBe("success");
      expect(fake.fetchMock).toHaveBeenCalledTimes(1);
    });

    it("schedules 1m then 5m backoff and marks failed after WEBHOOK_MAX_ATTEMPTS", async () => {
      expect(WEBHOOK_MAX_ATTEMPTS).toBe(3);
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const prisma = createPrismaMock();
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });

      const fake = installFakeFetch(() => new Response("", { status: 500, statusText: "Internal Server Error" }));
      restoreFetch = fake.restore;

      for (let attemptIndex = 0; attemptIndex < WEBHOOK_MAX_ATTEMPTS; attemptIndex += 1) {
        prisma.webhookDelivery.findUnique.mockResolvedValueOnce({
          id: "delivery-1",
          status: "pending",
          attempts: attemptIndex,
          payload: {},
          event: "task.created",
          webhook: webhookRowFor(secret),
        });

        const result = await deliverWebhook(prisma as never, "delivery-1", { now });
        const failureCall = prisma.webhookDelivery.updateMany.mock.calls.at(-1)?.[0] as {
          data: Record<string, unknown>;
        };
        const attempts = attemptIndex + 1;

        if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
          expect(result.status).toBe("failed");
          expect(failureCall.data.status).toBe("failed");
          expect(failureCall.data.nextAttemptAt).toEqual(now);
        } else {
          expect(result.status).toBe("pending");
          expect(failureCall.data.status).toBeUndefined();
          const expectedDelay = WEBHOOK_RETRY_DELAYS_MS[attempts - 1];
          expect(failureCall.data.nextAttemptAt).toEqual(new Date(now.getTime() + expectedDelay));
        }
        expect(failureCall.data.attempts).toEqual({ set: attempts });
      }

      expect(fake.fetchMock).toHaveBeenCalledTimes(WEBHOOK_MAX_ATTEMPTS);
    });
  });

  describe("processDueWebhookDeliveries", () => {
    it("sweeps pending deliveries whose nextAttemptAt has come due", async () => {
      const now = new Date("2026-01-01T00:00:00.000Z");
      const secret = "whsec_test_secret";
      const prisma = createPrismaMock();
      prisma.webhookDelivery.findMany.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
      prisma.webhookDelivery.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
        id: args.where.id,
        status: "pending",
        attempts: 0,
        payload: {},
        event: "task.created",
        webhook: webhookRowFor(secret),
      }));

      const fake = installFakeFetch(() => jsonResponse({}, 200));
      restoreFetch = fake.restore;

      const result = await processDueWebhookDeliveries(prisma as never, now);

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
      expect(fake.fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps sweeping even when deliverWebhook throws for one row", async () => {
      const prisma = createPrismaMock();
      prisma.webhookDelivery.findMany.mockResolvedValue([{ id: "d1" }, { id: "d2" }]);
      prisma.webhookDelivery.findUnique.mockImplementation(async (args: { where: { id: string } }) => {
        if (args.where.id === "d1") {
          throw new Error("boom");
        }
        return {
          id: "d2",
          status: "pending",
          attempts: 0,
          payload: {},
          event: "task.created",
          webhook: webhookRowFor("whsec_x"),
        };
      });
      prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });

      const fake = installFakeFetch(() => jsonResponse({}, 200));
      restoreFetch = fake.restore;
      vi.spyOn(console, "error").mockImplementation(() => {});

      const result = await processDueWebhookDeliveries(prisma as never, new Date());
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(1);
    });
  });

  describe("sendWebhookPing", () => {
    it("sends a signed ping and reports success", async () => {
      const secret = "whsec_ping_secret";
      const prisma = createPrismaMock();
      prisma.project.findUnique.mockResolvedValue({ id: "p1", key: "AAA", slug: "proj", name: "Proj" });

      const fake = installFakeFetch(() => jsonResponse({}, 200));
      restoreFetch = fake.restore;

      const result = await sendWebhookPing(prisma as never, {
        webhookId: "wh1",
        url: PUBLIC_URL,
        encryptedSecret: encryptSecret(secret),
        projectId: "p1",
      });

      expect(result).toEqual({ status: "success", responseCode: 200, error: null });
      expect(fake.requests[0].headers["x-taskito-event"]).toBe("ping");
    });

    it("rejects a private ping target before sending anything", async () => {
      const prisma = createPrismaMock();
      const fake = installFakeFetch(() => {
        throw new Error("must not be called");
      });
      restoreFetch = fake.restore;

      const result = await sendWebhookPing(prisma as never, {
        webhookId: "wh1",
        url: "http://10.0.0.5/hook",
        encryptedSecret: encryptSecret("whsec_x"),
        projectId: "p1",
      });

      expect(result.status).toBe("failed");
      expect(result.error).toMatch(/private, loopback, or link-local/);
      expect(fake.fetchMock).not.toHaveBeenCalled();
    });
  });
});
