import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { createPrismaMock, type PrismaMock } from "@/test/prisma-mock";
import {
  decryptWithKey,
  encryptWithKey,
  keyFromSecretMaterial,
  SECRET_CIPHER_VERSION_PREFIX,
} from "@/lib/secret-crypto";
import {
  REENCRYPT_UPDATE_BATCH_SIZE,
  reencryptAiSecrets,
  reencryptTxOptions,
  resolveNewKey,
  resolveOldKey,
  resolveReencryptTxTimeoutMs,
  type EncryptedRow,
  type ResolvedKey,
  type TableStats,
} from "@/server/services/ai/secret-reencryption";

const MASTER_KEY = Buffer.alloc(32, 7);

const ENV_KEYS = [
  "AI_SECRET_MASTER_KEY",
  "AI_SECRET_MASTER_KEY_OLD",
  "AUTH_SECRET",
  "REENCRYPT_TX_TIMEOUT_MS",
] as const;

function buildLegacyUnprefixed(plaintext: string, key: Buffer) {
  // Mimics pre-versioning ciphertext: raw payload, no `v1:` prefix.
  return encryptWithKey(plaintext, key).slice(SECRET_CIPHER_VERSION_PREFIX.length);
}

function toTableStats(stats: TableStats[], label: string) {
  return stats.find((entry) => entry.label === label);
}

function resolveBothKeys(): { oldResolved: ResolvedKey; newResolved: ResolvedKey } {
  return {
    oldResolved: { key: MASTER_KEY, source: "AI_SECRET_MASTER_KEY_OLD" },
    newResolved: { key: MASTER_KEY, source: "AI_SECRET_MASTER_KEY" },
  };
}

describe("secret re-encryption core", () => {
  let prisma: PrismaMock;
  let queryRawMock: Mock;
  let lastTxOptions: { timeout?: number; maxWait?: number } | undefined;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    prisma = createPrismaMock();

    // The rotation mutates the transaction client via a tagged-template
    // `$queryRaw` call. The generic prisma mock treats one-level properties as
    // model delegates (never callable), so hand the transaction a context that
    // exposes a real `$queryRaw` mock next to the normal model delegates.
    queryRawMock = vi.fn<(query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>>() as unknown as Mock;
    queryRawMock.mockResolvedValue([[]]);
    const txWithQueryRaw = new Proxy(prisma, {
      get(target, prop) {
        if (prop === "$queryRaw") {
          return queryRawMock;
        }
        return Reflect.get(target, prop, target);
      },
    });
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>, options?: { timeout?: number; maxWait?: number }) => {
      lastTxOptions = options;
      return (callback as (tx: unknown) => Promise<unknown>)(txWithQueryRaw);
    });

    lastTxOptions = undefined;
    prisma.aiProviderConnection.findMany.mockResolvedValue([]);
    prisma.aiProviderConnection.count.mockResolvedValue(0);
    prisma.oidcProviderConnection.findMany.mockResolvedValue([]);
    prisma.oidcProviderConnection.count.mockResolvedValue(0);
    prisma.storageSettings.findMany.mockResolvedValue([]);
    prisma.storageSettings.count.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  describe("transaction configuration", () => {
    it("runs the whole rotation inside a single interactive transaction with a generous default timeout", async () => {
      const oldResolved: ResolvedKey = { key: MASTER_KEY, source: "AI_SECRET_MASTER_KEY_OLD" };
      const newResolved: ResolvedKey = { key: Buffer.alloc(32, 9), source: "AI_SECRET_MASTER_KEY" };

      await reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: true });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(lastTxOptions).toEqual({ timeout: 300_000, maxWait: 10_000 });
    });

    it("reads the timeout from REENCRYPT_TX_TIMEOUT_MS (with sane bounds)", () => {
      delete process.env.REENCRYPT_TX_TIMEOUT_MS;
      expect(resolveReencryptTxTimeoutMs()).toBe(300_000);
      expect(reencryptTxOptions()).toEqual({ timeout: 300_000, maxWait: 10_000 });

      process.env.REENCRYPT_TX_TIMEOUT_MS = "600000";
      expect(reencryptTxOptions()).toEqual({ timeout: 600_000, maxWait: 10_000 });

      process.env.REENCRYPT_TX_TIMEOUT_MS = "5000";
      expect(reencryptTxOptions()).toEqual({ timeout: 5000, maxWait: 5000 });

      // Garbage or too-small values fall back to the default.
      process.env.REENCRYPT_TX_TIMEOUT_MS = "not-a-number";
      expect(resolveReencryptTxTimeoutMs()).toBe(300_000);
      process.env.REENCRYPT_TX_TIMEOUT_MS = "50";
      expect(resolveReencryptTxTimeoutMs()).toBe(300_000);
    });
  });

  describe("key material (exact AUTH_SECRET derivation)", () => {
    it("derives the legacy fallback key from the exact, untrimmed AUTH_SECRET", () => {
      const rawSecret = "  padded auth secret  ";
      process.env.AUTH_SECRET = rawSecret;
      delete process.env.AI_SECRET_MASTER_KEY;
      delete process.env.AI_SECRET_MASTER_KEY_OLD;

      const oldResolved = resolveOldKey();
      expect(oldResolved.source).toBe("sha256(AUTH_SECRET)");
      expect(oldResolved.key.equals(keyFromSecretMaterial(rawSecret))).toBe(true);
      // Trimming would derive a different (wrong) legacy key.
      expect(oldResolved.key.equals(keyFromSecretMaterial(rawSecret.trim()))).toBe(false);

      const newResolved = resolveNewKey();
      expect(newResolved.key.equals(keyFromSecretMaterial(rawSecret))).toBe(true);
    });

    it("throws when no old key material is available", () => {
      delete process.env.AUTH_SECRET;
      delete process.env.AI_SECRET_MASTER_KEY_OLD;
      expect(() => resolveOldKey()).toThrow(/Old key material is required/);
    });
  });

  describe("rotation behaviour with a mocked prisma", () => {
    /**
     * A tiny backing store behind the prisma delegates so mutations are
     * observable and findMany reflects the post-update state.
     */
    function useStore(initialRows: EncryptedRow[]) {
      const store = new Map<string, string>();
      for (const row of initialRows) {
        store.set(row.id, row.encrypted ?? "");
      }
      prisma.aiProviderConnection.findMany.mockImplementation(() =>
        Promise.resolve([...store.entries()].map(([id, encryptedSecret]) => ({ id, encryptedSecret }))),
      );
      prisma.aiProviderConnection.update.mockImplementation(
        (args: { where: { id: string }; data: { encryptedSecret: string } }) => {
          store.set(args.where.id, args.data.encryptedSecret);
          return Promise.resolve({});
        },
      );
      return store;
    }

    it("re-encrypts legacy rows and counts versioned rows as current without rewriting (same keys)", async () => {
      const versioned = encryptWithKey("alpha-provider-secret", MASTER_KEY);
      const legacy = buildLegacyUnprefixed("beta-provider-secret", MASTER_KEY);
      const store = useStore([
        { id: "row-a", encrypted: versioned },
        { id: "row-b", encrypted: legacy },
        { id: "row-c", encrypted: null },
        { id: "row-d", encrypted: "" },
      ]);
      const { oldResolved, newResolved } = resolveBothKeys();

      const allStats = await reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: false });

      const aiStats = toTableStats(allStats, "AiProviderConnection.encryptedSecret");
      expect(aiStats).toMatchObject({ scanned: 4, reencrypted: 1, alreadyCurrent: 1, skipped: 2, failed: 0 });

      // Only the legacy (unversioned) row is normalized; the versioned row is
      // left byte-for-byte intact even though a fresh IV would differ.
      const updateCalls = prisma.aiProviderConnection.update.mock.calls;
      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0][0]).toMatchObject({ where: { id: "row-b" } });
      expect(store.get("row-a")).toBe(versioned);
      expect(store.get("row-b")!.startsWith("v1:")).toBe(true);
      expect(decryptWithKey(store.get("row-b")!, MASTER_KEY)).toBe("beta-provider-secret");
    });

    it("is idempotent: a second same-key run rewrites nothing", async () => {
      const versioned = encryptWithKey("alpha-provider-secret", MASTER_KEY);
      const legacy = buildLegacyUnprefixed("beta-provider-secret", MASTER_KEY);
      const store = useStore([
        { id: "row-a", encrypted: versioned },
        { id: "row-b", encrypted: legacy },
      ]);
      const { oldResolved, newResolved } = resolveBothKeys();

      await reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: false });
      const afterFirstRun = new Map(store);

      prisma.aiProviderConnection.update.mockClear();
      const secondRun = await reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: false });

      expect(prisma.aiProviderConnection.update).not.toHaveBeenCalled();
      const aiStats = toTableStats(secondRun, "AiProviderConnection.encryptedSecret");
      expect(aiStats).toMatchObject({ scanned: 2, reencrypted: 0, alreadyCurrent: 2, failed: 0 });
      // The stored ciphertext is exactly what it was after the first run.
      expect([...store.entries()]).toEqual([...afterFirstRun.entries()]);
    });

    it("flushes all batched updates even when the row count exceeds the batch size", async () => {
      const otherKey = Buffer.alloc(32, 11);
      const rowCount = REENCRYPT_UPDATE_BATCH_SIZE + 20;
      const rows: EncryptedRow[] = [];
      for (let index = 0; index < rowCount; index += 1) {
        rows.push({ id: `row-${index}`, encrypted: buildLegacyUnprefixed(`secret-${index}`, MASTER_KEY) });
      }
      const store = useStore(rows);
      const oldResolved: ResolvedKey = { key: MASTER_KEY, source: "AI_SECRET_MASTER_KEY_OLD" };
      const newResolved: ResolvedKey = { key: otherKey, source: "AI_SECRET_MASTER_KEY" };

      const allStats = await reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: false });

      expect(store.size).toBe(rowCount);
      expect(prisma.aiProviderConnection.update).toHaveBeenCalledTimes(rowCount);
      for (let index = 0; index < rowCount; index += 1) {
        const encrypted = store.get(`row-${index}`)!;
        expect(encrypted.startsWith("v1:")).toBe(true);
        expect(decryptWithKey(encrypted, otherKey)).toBe(`secret-${index}`);
      }
      const aiStats = toTableStats(allStats, "AiProviderConnection.encryptedSecret");
      expect(aiStats).toMatchObject({ scanned: rowCount, reencrypted: rowCount, failed: 0 });
    });

    it("takes the advisory lock and aborts when row counts change during the run", async () => {
      useStore([
        { id: "row-a", encrypted: buildLegacyUnprefixed("secret-a", MASTER_KEY) },
        { id: "row-b", encrypted: buildLegacyUnprefixed("secret-b", MASTER_KEY) },
      ]);
      prisma.aiProviderConnection.count
        .mockResolvedValueOnce(2) // initial count
        .mockResolvedValue(3); // final rescan sees an inserted row
      const oldResolved: ResolvedKey = { key: MASTER_KEY, source: "AI_SECRET_MASTER_KEY_OLD" };
      const newResolved: ResolvedKey = { key: Buffer.alloc(32, 9), source: "AI_SECRET_MASTER_KEY" };

      await expect(reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: false })).rejects.toThrow(
        /Concurrent writes detected while re-encrypting/,
      );
      // The advisory lock is acquired inside the transaction.
      expect(queryRawMock).toHaveBeenCalled();
    });

    it("reports each sensitive table's statistics", async () => {
      prisma.oidcProviderConnection.findMany.mockResolvedValue([
        { id: "oidc-1", encryptedClientSecret: buildLegacyUnprefixed("oidc-secret", MASTER_KEY) },
      ]);
      prisma.oidcProviderConnection.count.mockResolvedValue(1);
      prisma.storageSettings.findMany.mockResolvedValue([
        { id: "storage-1", encryptedS3SecretAccessKey: buildLegacyUnprefixed("s3-secret", MASTER_KEY), encryptedS3SessionToken: null },
      ]);
      prisma.storageSettings.count.mockResolvedValue(1);

      useStore([{ id: "ai-1", encrypted: buildLegacyUnprefixed("ai-secret", MASTER_KEY) }]);
      const oldResolved: ResolvedKey = { key: MASTER_KEY, source: "AI_SECRET_MASTER_KEY_OLD" };
      const newResolved: ResolvedKey = { key: Buffer.alloc(32, 9), source: "AI_SECRET_MASTER_KEY" };

      const allStats = await reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: false });

      expect(toTableStats(allStats, "AiProviderConnection.encryptedSecret")).toMatchObject({ reencrypted: 1 });
      expect(toTableStats(allStats, "OidcProviderConnection.encryptedClientSecret")).toMatchObject({ reencrypted: 1 });
      expect(toTableStats(allStats, "StorageSettings.encryptedS3SecretAccessKey")).toMatchObject({ reencrypted: 1 });
      expect(toTableStats(allStats, "StorageSettings.encryptedS3SessionToken")).toMatchObject({ skipped: 1 });
    });

    it("aborts with a clear error when a row decrypts under neither key", async () => {
      useStore([{ id: "row-a", encrypted: "bm90LWEtY2lwaGVydGV4dA==" }]);
      const oldResolved: ResolvedKey = { key: MASTER_KEY, source: "AI_SECRET_MASTER_KEY_OLD" };
      const newResolved: ResolvedKey = { key: Buffer.alloc(32, 9), source: "AI_SECRET_MASTER_KEY" };

      await expect(reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun: false })).rejects.toThrow(
        /Failed to decrypt 1 row\(s\)/,
      );
      expect(prisma.aiProviderConnection.update).not.toHaveBeenCalled();
    });
  });
});