/**
 * Re-encrypts stored encrypted secrets (AI provider API keys, OIDC client
 * secrets, S3 storage credentials) with the current key material.
 *
 * Old key material (used to decrypt existing ciphertext), in order:
 *   1. AI_SECRET_MASTER_KEY_OLD (base64-encoded 32-byte key)
 *   2. sha256(AUTH_SECRET) — the historic fallback key, derived from the exact
 *      (untrimmed) value of AUTH_SECRET
 *
 * New key material (used to re-encrypt), in order:
 *   1. AI_SECRET_MASTER_KEY (base64-encoded 32-byte key)
 *   2. sha256(AUTH_SECRET) — warned about; avoid in production
 *
 * The rotation runs in a single interactive transaction. Three table scans
 * plus per-row updates can outlive the Prisma default 5s transaction timeout,
 * so the timeout is configurable:
 *   REENCRYPT_TX_TIMEOUT_MS=<milliseconds>   (default: 300000)
 *
 * The transaction also takes a Postgres advisory lock and re-counts sensitive
 * rows at the end; it aborts (rolling everything back) if rows were added or
 * removed while the run was in flight. That is a safety net, not a substitute
 * for exclusivity: stop the app (or make AI/provider and storage settings
 * temporarily read-only) for the duration of a real rotation.
 *
 * Usage:
 *   DRY RUN:    npm run db:reencrypt-ai-secrets -- --dry-run
 *   REAL RUN:   npm run db:reencrypt-ai-secrets
 *
 * Typical rotation from the legacy auth-secret fallback to a dedicated key:
 *   1. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
 *   2. PICK A MAINTENANCE WINDOW: stop Taskito (or pause AI + storage writes).
 *   3. DRY RUN:    AI_SECRET_MASTER_KEY=<new key> AUTH_SECRET=<unchanged> \
 *                    npm run db:reencrypt-ai-secrets -- --dry-run
 *   4. REAL RUN:   same command without --dry-run
 *   5. Update AI_SECRET_MASTER_KEY in the deployment environment and restart.
 */

import { PrismaClient } from "@prisma/client";

import {
  reencryptAiSecrets,
  resolveNewKey,
  resolveOldKey,
} from "../src/server/services/ai/secret-reencryption";

const dryRun = process.argv.includes("--dry-run");

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
    const allStats = await reencryptAiSecrets(prisma, { oldResolved, newResolved, dryRun });

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