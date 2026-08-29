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
