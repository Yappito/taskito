import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { REENCRYPT_ADVISORY_LOCK_KEY, withSecretRotationLock } from "@/server/services/ai/secret-reencryption";
import { STORAGE_SETTINGS_ID } from "@/server/services/storage-settings";
import { aiRouter } from "@/server/routers/ai";
import { oidcRouter } from "@/server/routers/oidc";
import { storageRouter } from "@/server/routers/storage";
import { webhookRouter } from "@/server/routers/webhook";
import { createCallerFactory } from "@/server/trpc";
import { adminUser, callerFor, type WiredActor } from "@/test/actors";
import { createPrismaMock, type PrismaMock } from "@/test/prisma-mock";

const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");

// storage-settings helpers read through the global @/lib/prisma client;
// swap it for a stub so the storage router test never needs DATABASE_URL.
const { prismaGlobalMock } = vi.hoisted(() => ({
  prismaGlobalMock: {
    storageSettings: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: prismaGlobalMock,
}));

/** Asserts the last-used prisma delegate ran inside the rotation lock tx. */
function expectAdvisoryLockTaken(prismaLocal: PrismaMock | WiredActor["prisma"], label: string) {
  const calls = (prismaLocal.$queryRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls;
  expect(calls.length, `${label} should have queried the advisory lock`).toBeGreaterThan(0);
  const lockCall = calls.find((call) => String((call[0] as unknown as string[]).join("")).includes("pg_advisory_xact_lock"));
  expect(lockCall, `${label} should take pg_advisory_xact_lock`).toBeDefined();
  const sql = (lockCall![0] as unknown as string[]).join("");
  // The key is bound as a parameter right after the lock placeholder.
  expect(sql).toContain("pg_advisory_xact_lock(");
  expect(lockCall![1]).toBe(REENCRYPT_ADVISORY_LOCK_KEY);
}

describe("secret writers take the rotation advisory lock (M6b)", () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("AUTH_SECRET", "rotation-lock-test-auth-secret");
    prisma = createPrismaMock();
    prisma.user.findUniqueOrThrow.mockResolvedValue({ id: "cmab8yxxu0001i7p4k8n2v3q1", role: "member" });
    prisma.user.findUnique.mockResolvedValue({ id: "cmab8yxxu0001i7p4k8n2v3q1", role: "member", disabledAt: null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("withSecretRotationLock runs the callback inside the advisory-lock transaction", async () => {
    const prismaLocal = createPrismaMock();
    const result = await withSecretRotationLock(prismaLocal as never, async () => "ok");
    expect(result).toBe("ok");
    const calls = (prismaLocal.$queryRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][0] as unknown as string[]).join("")).toContain("pg_advisory_xact_lock(");
    expect(calls[0][1]).toBe(REENCRYPT_ADVISORY_LOCK_KEY);
    // The whole callback ran inside prisma.$transaction.
    expect(prismaLocal.$transaction).toHaveBeenCalled();
  });

  it("ai router createUserProvider encrypts the secret inside the rotation lock", async () => {
    const createCaller = createCallerFactory(aiRouter);
    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "cmab8yxxu0001i7p4k8n2v3q1", role: "member" } } as never,
    });
    prisma.aiProviderConnection.create.mockResolvedValue({ id: "cmab8yxxp000ci7p4k8n2v3qf" });

    await caller.createUserProvider({
      label: "Test provider",
      adapter: "openai_compatible",
      baseUrl: "http://93.184.216.34/v1",
      model: "test-model",
      secret: "sk-test",
    });

    expectAdvisoryLockTaken(prisma, "createUserProvider");
    expect(prisma.aiProviderConnection.create).toHaveBeenCalled();
  });

  it("ai router updateProvider encrypts the rotated secret inside the rotation lock", async () => {
    const createCaller = createCallerFactory(aiRouter);
    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: "cmab8yxxu0001i7p4k8n2v3q1", role: "member" } } as never,
    });
    const providerId = "cmab8yxxp0004i7p4k8n2v3q4";
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue({
      id: providerId,
      scope: "user",
      ownerUserId: "cmab8yxxu0001i7p4k8n2v3q1",
      projectId: null,
      adapter: "openai_compatible",
      baseUrl: "http://93.184.216.34/v1",
      model: "test-model",
      encryptedSecret: null,
      isEnabled: true,
      isDefault: false,
    });
    prisma.aiProviderConnection.update.mockResolvedValue({ id: providerId });

    await caller.updateProvider({ id: providerId, secret: "sk-rotated" });

    expectAdvisoryLockTaken(prisma, "updateProvider");
    expect(prisma.aiProviderConnection.update).toHaveBeenCalled();
  });

  it("oidc router create encrypts the client secret inside the rotation lock", async () => {
    const actor = adminUser();
    const caller = callerFor(oidcRouter, actor.prisma, actor.sessionUser);
    actor.prisma.oidcProviderConnection.create.mockResolvedValue({
      id: "cmab8yxxp000bi7p4k8n2v3qe",
      providerId: "test-idp",
    });

    await caller.create({
      providerId: "test-idp",
      name: "Test IdP",
      issuer: "https://idp.example.com",
      clientId: "client-123",
      clientSecret: "secret-123",
    });

    expectAdvisoryLockTaken(actor.prisma, "oidc.create");
    expect(actor.prisma.oidcProviderConnection.create).toHaveBeenCalled();
  });

  it("oidc router update encrypts a rotated client secret inside the rotation lock", async () => {
    const actor = adminUser();
    const caller = callerFor(oidcRouter, actor.prisma, actor.sessionUser);
    actor.prisma.oidcProviderConnection.findUniqueOrThrow.mockResolvedValue({
      id: "cmab8yxxp000bi7p4k8n2v3qe",
      providerId: "test-idp",
    });
    actor.prisma.oidcProviderConnection.update.mockResolvedValue({
      id: "cmab8yxxp000bi7p4k8n2v3qe",
      providerId: "test-idp",
    });

    await caller.update({
      id: "cmab8yxxp000bi7p4k8n2v3qe",
      clientSecret: "rotated-secret",
    });

    expectAdvisoryLockTaken(actor.prisma, "oidc.update");
    expect(actor.prisma.oidcProviderConnection.update).toHaveBeenCalled();
  });

  it("storage router save encrypts S3 secrets inside the rotation lock", async () => {
    const actor = adminUser();
    const caller = callerFor(storageRouter, actor.prisma, actor.sessionUser);
    actor.prisma.storageSettings.findUnique.mockResolvedValue(null);
    actor.prisma.storageSettings.upsert.mockResolvedValue({ id: "default", provider: "s3" });
    prismaGlobalMock.storageSettings.findUnique.mockResolvedValue(null);

    await caller.save({
      provider: "s3",
      s3Bucket: "taskito-uploads",
      s3Region: "us-east-1",
      s3AccessKeyId: "AKIATEST",
      s3SecretAccessKey: "s3-secret",
    });

    expectAdvisoryLockTaken(actor.prisma, "storage.save");
    expect(actor.prisma.storageSettings.upsert).toHaveBeenCalled();
  });

  // M4: the pre-rotation ciphertext differs from the value visible once the
  // lock is held — a rotation commits between lock acquisition and the save's
  // row read. The preservation upsert must write back what the row holds
  // UNDER the lock, never the stale pre-lock snapshot.
  const PRE_ROTATION_CIPHERTEXT = "old-key-ciphertext:v1";
  const POST_ROTATION_CIPHERTEXT = "new-key-ciphertext:v2";
  const PRE_ROTATION_TOKEN = "old-key-session-token:v1";
  const POST_ROTATION_TOKEN = "new-key-session-token:v2";

  it("storage.save re-reads the stored ciphertext inside the rotation lock and never restores a stale snapshot (M4)", async () => {
    const actor = adminUser();
    const caller = callerFor(storageRouter, actor.prisma, actor.sessionUser);

    // The live row state. A master-key rotation commits right after the
    // advisory lock is taken (simulated by the $queryRaw lock call) and
    // replaces the stored ciphertext with new-key values.
    let storedRow: { encryptedS3SecretAccessKey: string | null; encryptedS3SessionToken: string | null } = {
      encryptedS3SecretAccessKey: PRE_ROTATION_CIPHERTEXT,
      encryptedS3SessionToken: PRE_ROTATION_TOKEN,
    };
    const events: string[] = [];

    actor.prisma.$queryRaw.mockImplementation(async () => {
      events.push("lock");
      // The rotation serializes on pg_advisory_xact_lock and re-encrypts the
      // S3 row while this save waits for / holds the lock.
      storedRow = {
        encryptedS3SecretAccessKey: POST_ROTATION_CIPHERTEXT,
        encryptedS3SessionToken: POST_ROTATION_TOKEN,
      };
      return [[]];
    });
    actor.prisma.storageSettings.findUnique.mockImplementation(async () => {
      events.push("read");
      return { id: STORAGE_SETTINGS_ID, provider: "s3", ...storedRow, s3AccessKeyId: "AKIATEST" };
    });
    actor.prisma.storageSettings.upsert.mockImplementation(async () => {
      events.push("upsert");
      return { id: STORAGE_SETTINGS_ID, provider: "s3" };
    });
    prismaGlobalMock.storageSettings.findUnique.mockResolvedValue(null);

    // No replacement S3 secret / session token: the save must PRESERVE the
    // ciphertext it finds under the lock.
    await caller.save({
      provider: "s3",
      s3Bucket: "taskito-uploads",
      s3Region: "us-east-1",
      s3AccessKeyId: "AKIATEST",
      s3SecretAccessKey: null,
      s3SessionToken: null,
    });

    // The row read itself happens under the lock: the advisory lock is taken
    // before the existing row is read (and the upsert follows both).
    expect(events).toEqual(["lock", "read", "upsert"]);

    const upsertArgs = actor.prisma.storageSettings.upsert.mock.calls[0][0];
    expect(upsertArgs.update.encryptedS3SecretAccessKey).toBe(POST_ROTATION_CIPHERTEXT);
    expect(upsertArgs.update.encryptedS3SessionToken).toBe(POST_ROTATION_TOKEN);
    // The stale pre-rotation snapshot must never be written back.
    expect(upsertArgs.update.encryptedS3SecretAccessKey).not.toBe(PRE_ROTATION_CIPHERTEXT);
    expect(upsertArgs.update.encryptedS3SessionToken).not.toBe(PRE_ROTATION_TOKEN);
  });

  it("storage.save keeps the exists-based validation inside the lock transaction (M4)", async () => {
    const actor = adminUser();
    const caller = callerFor(storageRouter, actor.prisma, actor.sessionUser);

    const events: string[] = [];
    actor.prisma.$queryRaw.mockImplementation(async () => {
      events.push("lock");
      return [[]];
    });
    actor.prisma.storageSettings.findUnique.mockImplementation(async () => {
      events.push("read");
      // The row (and its stored ciphertext) disappears right under the lock.
      return null;
    });

    await expect(
      caller.save({
        provider: "s3",
        s3Bucket: "taskito-uploads",
        s3AccessKeyId: "AKIATEST",
        s3SecretAccessKey: null,
      }),
    ).rejects.toThrow(/S3 secret access key is required/);

    // The validation saw the row state from inside the advisory-lock tx.
    expect(events).toEqual(["lock", "read"]);
    expect(actor.prisma.storageSettings.upsert).not.toHaveBeenCalled();
  });

  it("webhook router create writes the signing secret inside the rotation lock", async () => {
    // Webhook.encryptedSecret is covered by the rotation plan, so its writer
    // must serialize with a rotation just like the AI/OIDC/S3 writers.
    const actor = adminUser();
    const caller = callerFor(webhookRouter, actor.prisma, actor.sessionUser);
    actor.prisma.webhook.count.mockResolvedValue(0);
    actor.prisma.webhook.create.mockResolvedValue({
      id: "cmab8yxxp000wi7p4k8n2v3qh",
      url: "http://93.184.216.34/taskito",
      events: ["task.created"],
      isEnabled: true,
      createdByUserId: actor.sessionUser.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await caller.create({
      projectId: "cmab8yxxp000pi7p4k8n2v3qp",
      url: "http://93.184.216.34/taskito",
      events: ["task.created"],
    });

    expectAdvisoryLockTaken(actor.prisma, "webhook.create");
    expect(actor.prisma.webhook.create).toHaveBeenCalled();
  });
});
