/**
 * Re-encryption core for stored encrypted secrets (AI provider API keys, OIDC
 * client secrets, S3 storage credentials, webhook signing secrets). Kept as a
 * library module (without a runtime dependency on Prisma) so the rotation
 * logic can be unit-tested; the CLI wrapper lives in `scripts/reencrypt-ai-secrets.ts`.
 *
 * Key material (old / new), in order:
 *   1. AI_SECRET_MASTER_KEY_OLD / AI_SECRET_MASTER_KEY (base64-encoded 32-byte key)
 *   2. sha256(AUTH_SECRET) — the historic fallback key, derived from the exact
 *      (untrimmed) value so ciphertext produced before whitespace-aware parsing
 *      still decrypts.
 *
 * Safety properties:
 *   - the rotation runs inside a single interactive transaction (atomic);
 *   - the transaction holds `pg_advisory_xact_lock` and re-compares per-row
 *     fingerprints (id + ciphertext) at the end, aborting loudly if any row
 *     was added, removed, or changed while it was running — including
 *     same-count in-place rewrites a plain row-count comparison would miss;
 *   - every secret writer (AI provider create/update, OIDC provider
 *     create/update, storage settings save) takes the same advisory lock via
 *     withSecretRotationLock inside its own transaction, so ordinary writes
 *     serialize with a rotation and cannot overwrite fresh ciphertext with
 *     plaintext encrypted under the old key mid-run;
 *   - interactive transaction timeouts are configurable via
 *     REENCRYPT_TX_TIMEOUT_MS (default 300s) because three table scans plus
 *     per-row updates can exceed the Prisma 5s default;
 *   - versioned rows are never rewritten when old and new key material are
 *     identical (a fresh IV would produce a different ciphertext every run).
 */

import type { Prisma } from "@prisma/client";

import {
  decryptWithKey,
  encryptWithKey,
  isVersionedSecret,
  keyFromBase64Material,
  keyFromSecretMaterial,
} from "@/lib/secret-crypto";

export type KeyMaterialSource =
  | "AI_SECRET_MASTER_KEY"
  | "AI_SECRET_MASTER_KEY_OLD"
  | "sha256(AUTH_SECRET)";

export type ResolvedKey = { key: Buffer; source: KeyMaterialSource };

export type TableStats = {
  label: string;
  scanned: number;
  reencrypted: number;
  alreadyCurrent: number;
  skipped: number;
  failed: number;
};

export type EncryptedRow = { id: string; encrypted: string | null };

/**
 * Arbitrary application-specific key for the Postgres advisory lock.
 *
 * The rotation takes an exclusive transaction-scoped lock under this key and,
 * since the writer lock was introduced, every normal secret writer (AI
 * provider create/update, OIDC provider create/update, storage settings save)
 * takes the same lock inside its own transaction — so the rotation serialises
 * against all writers and its row fingerprints can no longer be stale.
 */
export const REENCRYPT_ADVISORY_LOCK_KEY = 7_381_254_996_121;

/** A client able to open the transaction the writer lock lives in. */
export interface SecretRotationLockClient {
  $transaction: <T>(
    callback: (tx: Prisma.TransactionClient) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Runs `run` inside a transaction that first takes the shared re-encryption
 * advisory lock (`pg_advisory_xact_lock(REENCRYPT_ADVISORY_LOCK_KEY)`).
 *
 * Secret writers (AI provider create/update, OIDC provider create/update,
 * storage settings save) must route all writes of encrypted key material
 * through this helper so they never interleave with a key rotation: without
 * it, a secret written after the rotation's scan was overwritten with stale
 * plaintext, or old-key ciphertext was written after the rotation (M6).
 */
export async function withSecretRotationLock<T>(
  client: SecretRotationLockClient,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${REENCRYPT_ADVISORY_LOCK_KEY})`;
    return run(tx);
  });
}

const DEFAULT_REENCRYPT_TX_TIMEOUT_MS = 300_000;
const MAX_REENCRYPT_TX_MAX_WAIT_MS = 10_000;

/** Rows updated per `Promise.all` batch inside the transaction. */
export const REENCRYPT_UPDATE_BATCH_SIZE = 50;

export function resolveReencryptTxTimeoutMs(): number {
  const raw = process.env.REENCRYPT_TX_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_REENCRYPT_TX_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1_000) {
    return DEFAULT_REENCRYPT_TX_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

/** Interactive transaction options for the rotation (see module docs). */
export function reencryptTxOptions(txTimeoutMs = resolveReencryptTxTimeoutMs()) {
  const timeout = Math.max(txTimeoutMs, 1_000);
  return { timeout, maxWait: Math.min(timeout, MAX_REENCRYPT_TX_MAX_WAIT_MS) };
}

function resolveKeyFromBase64(envName: string): ResolvedKey | undefined {
  const raw = process.env[envName]?.trim();
  if (!raw) {
    return undefined;
  }

  return { key: keyFromBase64Material(raw, envName), source: envName as KeyMaterialSource };
}

export function resolveOldKey(): ResolvedKey {
  const fromOldMasterKey = resolveKeyFromBase64("AI_SECRET_MASTER_KEY_OLD");
  if (fromOldMasterKey) {
    return fromOldMasterKey;
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || !authSecret.trim()) {
    throw new Error(
      "Old key material is required: set AI_SECRET_MASTER_KEY_OLD (base64-encoded 32-byte key) " +
        "or AUTH_SECRET so the legacy fallback key can be derived.",
    );
  }

  // Use the exact original string: sha256 of the raw value, trimming would
  // change the derived key for deployments whose secret had whitespace.
  return { key: keyFromSecretMaterial(authSecret), source: "sha256(AUTH_SECRET)" };
}

export function resolveNewKey(): ResolvedKey {
  const fromMasterKey = resolveKeyFromBase64("AI_SECRET_MASTER_KEY");
  if (fromMasterKey) {
    return fromMasterKey;
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || !authSecret.trim()) {
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

export async function reencryptRows(
  rows: EncryptedRow[],
  update: (id: string, encrypted: string) => Promise<unknown>,
  stats: TableStats,
  oldResolved: ResolvedKey,
  newResolved: ResolvedKey,
  options: { dryRun: boolean },
): Promise<Map<string, string>> {
  const failures: { id: string; reason: string }[] = [];
  const pendingUpdates: { id: string; encrypted: string }[] = [];

  /** Applies pending updates in bounded batches; a dry run discards them. */
  const flushPendingUpdates = async () => {
    if (options.dryRun || pendingUpdates.length === 0) {
      pendingUpdates.length = 0;
      return;
    }
    for (let start = 0; start < pendingUpdates.length; start += REENCRYPT_UPDATE_BATCH_SIZE) {
      const batch = pendingUpdates.slice(start, start + REENCRYPT_UPDATE_BATCH_SIZE);
      // Any failed update rejects the batch and aborts the enclosing
      // transaction, keeping the whole run atomic.
      await Promise.all(batch.map((row) => update(row.id, row.encrypted)));
    }
    pendingUpdates.length = 0;
  };

  const appliedUpdates = new Map<string, string>();

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
        pendingUpdates.push({ id: row.id, encrypted: normalized });
        appliedUpdates.set(row.id, normalized);
        stats.reencrypted += 1;
      }
      continue;
    }

    // Same key material: a versioned row is already correctly encrypted. A
    // fresh IV would produce a ciphertext that never compares equal, turning
    // every second run into a pointless rewrite of every row.
    if (isVersionedSecret(encrypted) && oldResolved.key.equals(newResolved.key)) {
      stats.alreadyCurrent += 1;
      continue;
    }

    const reencrypted = encryptWithKey(plaintext, newResolved.key);
    pendingUpdates.push({ id: row.id, encrypted: reencrypted });
    appliedUpdates.set(row.id, reencrypted);
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

  await flushPendingUpdates();
  return appliedUpdates;
}

/**
 * Structural type of the Prisma transaction client used here, so unit tests
 * can pass a mock while production code passes `PrismaClient`.
 */
export interface ReencryptTransactionClient {
  $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>;
  aiProviderConnection: ReencryptDelegate;
  oidcProviderConnection: ReencryptDelegate;
  storageSettings: ReencryptDelegate;
  webhook: ReencryptDelegate;
}

export interface ReencryptDelegate {
  findMany(args: unknown): Promise<Array<{ id: string; [key: string]: unknown }>>;
  update(args: unknown): Promise<unknown>;
}

/**
 * Minimal structural type of the Prisma client surface used here, so unit
 * tests can pass a mock client while production code passes `PrismaClient`.
 */
export interface ReencryptPrismaClient {
  $transaction<T>(
    callback: (tx: ReencryptTransactionClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
}

export interface ReencryptOptions {
  oldResolved: ResolvedKey;
  newResolved: ResolvedKey;
  dryRun: boolean;
  txTimeoutMs?: number;
}

interface TablePlan {
  label: string;
  readRows: (tx: ReencryptTransactionClient) => Promise<EncryptedRow[]>;
  updateRow: (tx: ReencryptTransactionClient, id: string, encrypted: string) => Promise<unknown>;
}

/** Per-row fingerprint: id + the current ciphertext, joined. */
function rowFingerprint(id: string, encrypted: string | null | undefined) {
  return `${id}:${encrypted ?? ""}`;
}

/**
 * Compares the final rescan against the expected fingerprints (initial rows
 * plus this run's own re-encryption writes) and throws when anything was
 * added, removed, or rewritten concurrently. Unlike a row-count comparison,
 * this also catches same-count in-place secret changes — e.g. a secret
 * replaced after the initial scan — that would otherwise leave stale
 * plaintext or old-key ciphertext behind (M6).
 */
function assertFingerprintsUnchanged(planLabel: string, initial: Map<string, string>, appliedUpdates: Map<string, string>, finalRows: EncryptedRow[]) {
  const expected = new Map(initial);
  for (const [id, encrypted] of appliedUpdates) {
    expected.set(id, rowFingerprint(id, encrypted));
  }

  const finalFingerprints = new Map(finalRows.map((row) => [row.id, rowFingerprint(row.id, row.encrypted)]));
  if (finalFingerprints.size !== expected.size) {
    const added = [...finalFingerprints.keys()].filter((id) => !expected.has(id));
    const removed = [...expected.keys()].filter((id) => !finalFingerprints.has(id));
    throw concurrentWritesError(planLabel, added, removed, []);
  }

  const changed: string[] = [];
  for (const [id, fingerprint] of finalFingerprints) {
    if (expected.get(id) !== fingerprint) {
      changed.push(id);
    }
  }
  if (changed.length > 0) {
    throw concurrentWritesError(planLabel, [], [], changed);
  }
}

function concurrentWritesError(label: string, added: string[], removed: string[], changed: string[]) {
  const detail = [
    added.length ? `added: ${added.join(", ")}` : null,
    removed.length ? `removed: ${removed.join(", ")}` : null,
    changed.length ? `ciphertext changed: ${changed.join(", ")}` : null,
  ].filter(Boolean).join("; ");
  return new Error(
    `Concurrent writes detected while re-encrypting ${label}: sensitive rows changed during the run (${detail}). ` +
      "Nothing was committed. Run the rotation in a maintenance window " +
      "(stop Taskito, or make AI/storage settings temporarily read-only) and run it again.",
  );
}

/**
 * Runs the whole rotation against the given Prisma client (or transaction
 * mock). Returns per-table statistics; throws (rolling back the transaction)
 * when any row fails to decrypt or a sensitive row was added, removed, or
 * rewritten (fingerprint change) while the run was in flight.
 */
export async function reencryptAiSecrets(
  prisma: ReencryptPrismaClient,
  options: ReencryptOptions,
): Promise<TableStats[]> {
  const { oldResolved, newResolved, dryRun } = options;
  const txTimeoutMs = options.txTimeoutMs ?? resolveReencryptTxTimeoutMs();
  const allStats: TableStats[] = [];

  await prisma.$transaction(
    async (tx) => {
      // Serializes concurrent rotation runs. Normal app writes are unaffected;
      // pair this with a maintenance window (documented in the README) for a
      // fully exclusive rotation.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${REENCRYPT_ADVISORY_LOCK_KEY})`;

      const plans: TablePlan[] = [
        {
          label: "AiProviderConnection.encryptedSecret",
          readRows: async (tx) => {
            const rows = await tx.aiProviderConnection.findMany({ select: { id: true, encryptedSecret: true } });
            return rows.map((row) => ({ id: row.id, encrypted: row.encryptedSecret as string | null }));
          },
          updateRow: (tx, id, encrypted) =>
            tx.aiProviderConnection.update({ where: { id }, data: { encryptedSecret: encrypted } }),
        },
        {
          label: "OidcProviderConnection.encryptedClientSecret",
          readRows: async (tx) => {
            const rows = await tx.oidcProviderConnection.findMany({ select: { id: true, encryptedClientSecret: true } });
            return rows.map((row) => ({ id: row.id, encrypted: row.encryptedClientSecret as string | null }));
          },
          updateRow: (tx, id, encrypted) =>
            tx.oidcProviderConnection.update({ where: { id }, data: { encryptedClientSecret: encrypted } }),
        },
        {
          label: "StorageSettings.encryptedS3SecretAccessKey",
          readRows: async (tx) => {
            const rows = await tx.storageSettings.findMany({ select: { id: true, encryptedS3SecretAccessKey: true } });
            return rows.map((row) => ({ id: row.id, encrypted: (row.encryptedS3SecretAccessKey as string | null) ?? "" }));
          },
          updateRow: (tx, id, encrypted) =>
            tx.storageSettings.update({ where: { id }, data: { encryptedS3SecretAccessKey: encrypted } }),
        },
        {
          label: "StorageSettings.encryptedS3SessionToken",
          readRows: async (tx) => {
            const rows = await tx.storageSettings.findMany({ select: { id: true, encryptedS3SessionToken: true } });
            return rows.map((row) => ({ id: row.id, encrypted: (row.encryptedS3SessionToken as string | null) ?? "" }));
          },
          updateRow: (tx, id, encrypted) =>
            tx.storageSettings.update({ where: { id }, data: { encryptedS3SessionToken: encrypted } }),
        },
        {
          // Webhook signing secrets share the same master key: after a
          // cutover without this plan, every delivery would fail
          // decryption at dispatch time (bounded failure since the
          // dispatcher fix, but the integrations would be dead until the
          // secret was re-entered). Rotate them together, under the same
          // writer lock.
          label: "Webhook.encryptedSecret",
          readRows: async (tx) => {
            const rows = await tx.webhook.findMany({ select: { id: true, encryptedSecret: true } });
            return rows.map((row) => ({ id: row.id, encrypted: row.encryptedSecret as string | null }));
          },
          updateRow: (tx, id, encrypted) =>
            tx.webhook.update({ where: { id }, data: { encryptedSecret: encrypted } }),
        },
      ];

      interface PlanSnapshot {
        plan: TablePlan;
        initial: Map<string, string>;
        appliedUpdates: Map<string, string>;
      }
      const snapshots: PlanSnapshot[] = [];

      for (const plan of plans) {
        const tableStats = stats(plan.label);
        const rows = await plan.readRows(tx);
        const initial = new Map(rows.map((row) => [row.id, rowFingerprint(row.id, row.encrypted)]));
        const appliedUpdates = await reencryptRows(
          rows,
          (id, encrypted) => plan.updateRow(tx, id, encrypted),
          tableStats,
          oldResolved,
          newResolved,
          { dryRun },
        );
        snapshots.push({ plan, initial, appliedUpdates });
        allStats.push(tableStats);
      }

      // Final locked rescan: instead of comparing row counts (which misses
      // same-count secret rewrites), compare per-row fingerprints (id +
      // ciphertext) against the scan results — this run's own updates are
      // accounted for. Abort with a clear message when anything else changed
      // while the run was in flight; the transaction (and every assumption
      // those writes broke) rolls back together.
      for (const snapshot of snapshots) {
        const finalRows = await snapshot.plan.readRows(tx);
        assertFingerprintsUnchanged(snapshot.plan.label, snapshot.initial, snapshot.appliedUpdates, finalRows);
      }
    },
    reencryptTxOptions(txTimeoutMs),
  );

  return allStats;
}