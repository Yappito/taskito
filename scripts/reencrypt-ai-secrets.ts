/**
 * Re-encrypts stored encrypted secrets (AI provider API keys, OIDC client
 * secrets, S3 storage credentials) with the current key material.
 *
 * Old key material (used to decrypt existing ciphertext), in order:
 *   1. AI_SECRET_MASTER_KEY_OLD (base64-encoded 32-byte key)
 *   2. sha256(AUTH_SECRET) — the historic fallback key
 *
 * New key material (used to re-encrypt), in order:
 *   1. AI_SECRET_MASTER_KEY (base64-encoded 32-byte key)
 *   2. sha256(AUTH_SECRET) — warned about; avoid in production
 *
 * Usage:
 *   DRY RUN:    npm run db:reencrypt-ai-secrets -- --dry-run
 *   REAL RUN:   npm run db:reencrypt-ai-secrets
 *
 * Typical rotation from the legacy auth-secret fallback to a dedicated key:
 *   AI_SECRET_MASTER_KEY=<new key> AUTH_SECRET=<unchanged> \
 *     npm run db:reencrypt-ai-secrets -- --dry-run
 *   AI_SECRET_MASTER_KEY=<new key> AUTH_SECRET=<unchanged> \
 *     npm run db:reencrypt-ai-secrets
 * then update AI_SECRET_MASTER_KEY in the deployment environment and restart.
 */

import { PrismaClient } from "@prisma/client";

import {
  decryptWithKey,
  encryptWithKey,
  isVersionedSecret,
  keyFromBase64Material,
  keyFromSecretMaterial,
} from "../src/lib/secret-crypto";

type KeyMaterialSource =
  | "AI_SECRET_MASTER_KEY"
  | "AI_SECRET_MASTER_KEY_OLD"
  | "sha256(AUTH_SECRET)";

type ResolvedKey = { key: Buffer; source: KeyMaterialSource };

type TableStats = {
  label: string;
  scanned: number;
  reencrypted: number;
  alreadyCurrent: number;
  skipped: number;
  failed: number;
};

const dryRun = process.argv.includes("--dry-run");

function resolveKeyFromBase64(envName: string): ResolvedKey | undefined {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return undefined;
  }

  return { key: keyFromBase64Material(raw, envName), source: envName as KeyMaterialSource };
}

function resolveOldKey(): ResolvedKey {
  const fromOldMasterKey = resolveKeyFromBase64("AI_SECRET_MASTER_KEY_OLD");
  if (fromOldMasterKey) {
    return fromOldMasterKey;
  }

  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret) {
    throw new Error(
      "Old key material is required: set AI_SECRET_MASTER_KEY_OLD (base64-encoded 32-byte key) " +
        "or AUTH_SECRET so the legacy fallback key can be derived.",
    );
  }

  return { key: keyFromSecretMaterial(authSecret), source: "sha256(AUTH_SECRET)" };
}

function resolveNewKey(): ResolvedKey {
  const fromMasterKey = resolveKeyFromBase64("AI_SECRET_MASTER_KEY");
  if (fromMasterKey) {
    return fromMasterKey;
  }

  const authSecret = process.env.AUTH_SECRET?.trim();
  if (!authSecret) {
    throw new Error(
      "New key material is required: set AI_SECRET_MASTER_KEY (base64-encoded 32-byte key) " +
        "or AUTH_SECRET to re-encrypt under the fallback key.",
    );
  }

  console.warn(
    "⚠️  AI_SECRET_MASTER_KEY is not set; secrets will be re-encrypted under the sha256(AUTH_SECRET) " +
      "fallback key. Prefer a dedicated base64-encoded 32-byte key in production.",
  );

  return { key: keyFromSecretMaterial(authSecret), source: "sha256(AUTH_SECRET)" };
}

function stats(label: string): TableStats {
  return { label, scanned: 0, reencrypted: 0, alreadyCurrent: 0, skipped: 0, failed: 0 };
}

type EncryptedRow = { id: string; encrypted: string | null };

async function reencryptRows(
  rows: EncryptedRow[],
  update: (id: string, encrypted: string) => Promise<unknown>,
  stats: TableStats,
  oldResolved: ResolvedKey,
  newResolved: ResolvedKey,
) {
  const failures: { id: string; reason: string }[] = [];

  for (const row of rows) {
    stats.scanned += 1;

    const encrypted = row.encrypted;
    if (!encrypted || !encrypted.trim()) {
      stats.skipped += 1;
      continue;
    }

    let plaintext: string;
    try {
      plaintext = decryptWithKey(encrypted, oldResolved.key);
    } catch (oldKeyError) {
      // Not encrypted under the old key: it may already have been rotated to
      // the current key (rotation run twice, or written after a rotation).
      let current: string;
      try {
        current = decryptWithKey(encrypted, newResolved.key);
      } catch {
        stats.failed += 1;
        failures.push({
          id: row.id,
          reason: oldKeyError instanceof Error ? oldKeyError.message : String(oldKeyError),
        });
        continue;
      }

      if (isVersionedSecret(encrypted)) {
        stats.alreadyCurrent += 1;
      } else {
        // Decryptable with the current key but missing the version prefix:
        // rewrite it so the format is normalized.
        const normalized = encryptWithKey(current, newResolved.key);
        if (!dryRun) {
          await update(row.id, normalized);
        }
        stats.reencrypted += 1;
      }
      continue;
    }

    const reencrypted = encryptWithKey(plaintext, newResolved.key);
    if (reencrypted === encrypted) {
      stats.alreadyCurrent += 1;
      continue;
    }

    if (!dryRun) {
      await update(row.id, reencrypted);
    }
    stats.reencrypted += 1;
  }

  if (failures.length > 0) {
    const detail = failures
      .map((failure) => `  - ${failure.id}: ${failure.reason}`)
      .join("\n");
    throw new Error(
      `Failed to decrypt ${failures.length} row(s) in ${stats.label} with ${oldResolved.source}:\n${detail}\n` +
        "Aborting without changes. Provide the correct AI_SECRET_MASTER_KEY_OLD and retry.",
    );
  }
}

async function main() {
  const oldResolved = resolveOldKey();
  const newResolved = resolveNewKey();

  console.log(`Old key material: ${oldResolved.source}`);
  console.log(`New key material: ${newResolved.source}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "COMMIT"}`);

  if (
    oldResolved.source === "sha256(AUTH_SECRET)" &&
    newResolved.source === "sha256(AUTH_SECRET)"
  ) {
    console.log(
      "Note: old and new key material are identical; this run only normalizes ciphertext to the versioned format.",
    );
  }

  const prisma = new PrismaClient();

  try {
    const allStats: TableStats[] = [];

    await prisma.$transaction(async (tx) => {
      const aiRows = await tx.aiProviderConnection.findMany({
        select: { id: true, encryptedSecret: true },
      });
      const aiStats = stats("AiProviderConnection.encryptedSecret");
      await reencryptRows(
        aiRows.map((row) => ({ id: row.id, encrypted: row.encryptedSecret })),
        (id, encrypted) =>
          tx.aiProviderConnection.update({ where: { id }, data: { encryptedSecret: encrypted } }),
        aiStats,
        oldResolved,
        newResolved,
      );
      allStats.push(aiStats);

      const oidcRows = await tx.oidcProviderConnection.findMany({
        select: { id: true, encryptedClientSecret: true },
      });
      const oidcStats = stats("OidcProviderConnection.encryptedClientSecret");
      await reencryptRows(
        oidcRows.map((row) => ({ id: row.id, encrypted: row.encryptedClientSecret })),
        (id, encrypted) =>
          tx.oidcProviderConnection.update({ where: { id }, data: { encryptedClientSecret: encrypted } }),
        oidcStats,
        oldResolved,
        newResolved,
      );
      allStats.push(oidcStats);

      const storageRows = await tx.storageSettings.findMany({
        select: { id: true, encryptedS3SecretAccessKey: true, encryptedS3SessionToken: true },
      });
      const secretKeyStats = stats("StorageSettings.encryptedS3SecretAccessKey");
      const sessionTokenStats = stats("StorageSettings.encryptedS3SessionToken");
      await reencryptRows(
        storageRows.map((row) => ({ id: row.id, encrypted: row.encryptedS3SecretAccessKey ?? "" })),
        (id, encrypted) =>
          tx.storageSettings.update({ where: { id }, data: { encryptedS3SecretAccessKey: encrypted } }),
        secretKeyStats,
        oldResolved,
        newResolved,
      );
      await reencryptRows(
        storageRows.map((row) => ({ id: row.id, encrypted: row.encryptedS3SessionToken ?? "" })),
        (id, encrypted) =>
          tx.storageSettings.update({ where: { id }, data: { encryptedS3SessionToken: encrypted } }),
        sessionTokenStats,
        oldResolved,
        newResolved,
      );
      allStats.push(secretKeyStats, sessionTokenStats);
    });

    console.log("");
    console.log(dryRun ? "Dry run summary (no rows were written):" : "Re-encryption summary:");
    let totalReencrypted = 0;
    let totalAlreadyCurrent = 0;
    let totalSkipped = 0;
    for (const tableStats of allStats) {
      totalReencrypted += tableStats.reencrypted;
      totalAlreadyCurrent += tableStats.alreadyCurrent;
      totalSkipped += tableStats.skipped;
      console.log(
        `  ${tableStats.label}: ${tableStats.scanned} scanned, ` +
          `${tableStats.reencrypted} re-encrypted, ${tableStats.alreadyCurrent} already current, ` +
          `${tableStats.skipped} skipped (no secret), ${tableStats.failed} failed`,
      );
    }
    console.log(
      `Total: ${totalReencrypted} row(s) ${dryRun ? "would be " : ""}re-encrypted, ` +
        `${totalAlreadyCurrent} already current, ${totalSkipped} skipped`,
    );
    if (dryRun) {
      console.log("Run again without --dry-run to apply.");
    } else {
      console.log("✅ Done.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("❌ Re-encryption failed:", error);
  process.exit(1);
});