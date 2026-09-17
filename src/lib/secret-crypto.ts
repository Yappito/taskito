import crypto from "node:crypto";

const KEY_ENV_NAME = "AI_SECRET_MASTER_KEY";
const FALLBACK_ENV_NAME = "AUTH_SECRET";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export const SECRET_CIPHER_VERSION = 1;
export const SECRET_CIPHER_VERSION_PREFIX = `v${SECRET_CIPHER_VERSION}:`;

export type SecretKeySource = "master-key" | "auth-secret-fallback";

let warnedAboutAuthSecretFallback = false;

export function isVersionedSecret(encryptedSecret: string) {
  return encryptedSecret.startsWith(SECRET_CIPHER_VERSION_PREFIX);
}

/**
 * Reports which key material currently protects stored secrets (see
 * KEY_ENV_NAME / FALLBACK_ENV_NAME). Never throws: callers can use it in the
 * UI or logs to surface the auth-secret fallback even before the first
 * encrypt/decrypt call validates the configuration.
 */
export function getSecretKeySource(): SecretKeySource {
  const rawKey = process.env[KEY_ENV_NAME];
  if (rawKey && rawKey.trim()) {
    return "master-key";
  }

  return "auth-secret-fallback";
}

function requireKeySource(): SecretKeySource {
  const rawKey = process.env[KEY_ENV_NAME];
  if (rawKey && rawKey.trim()) {
    return "master-key";
  }

  // No master key configured: derive the key from AUTH_SECRET so deployments
  // work out of the box. The derivation is deterministic, so ciphertext stays
  // readable as long as AUTH_SECRET does not change; rotate properly via
  // `npm run db:reencrypt-ai-secrets` when moving to a dedicated master key.
  if (!warnedAboutAuthSecretFallback) {
    warnedAboutAuthSecretFallback = true;
    const isProduction = process.env.NODE_ENV === "production";
    console.warn(
      `[secret-crypto] ${KEY_ENV_NAME} is not set${isProduction ? " in production" : ""}; deriving the ` +
        `secret encryption key from ${FALLBACK_ENV_NAME}. This is deterministic (stored secrets remain ` +
        `readable), but rotating ${FALLBACK_ENV_NAME} invalidates stored secrets — set ${KEY_ENV_NAME} ` +
        `(any string; it is converted to a 32-byte key automatically) and run ` +
        `\`npm run db:reencrypt-ai-secrets\` to migrate.`,
    );
  }

  return "auth-secret-fallback";
}

let warnedAboutNonBase64KeyMaterial = false;

/**
 * Resolves 32-byte key material from a configured value.
 *
 * A value that already is a base64-encoded 32-byte key is used as-is (stable
 * across deployments, and the format documented for key rotation). Any other
 * value is converted automatically: it is hashed into a deterministic 32-byte
 * key, so operators can paste a plain token or passphrase without
 * pre-encoding it. The same input always yields the same key.
 */
export function keyFromMaterial(rawKey: string, envName = KEY_ENV_NAME) {
  const base64Key = Buffer.from(rawKey.trim(), "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }

  if (!warnedAboutNonBase64KeyMaterial) {
    warnedAboutNonBase64KeyMaterial = true;
    console.warn(
      `[secret-crypto] ${envName} is not a base64-encoded 32-byte key; converting it ` +
        `automatically (sha256) into 32-byte key material. The same value always ` +
        `yields the same key.`,
    );
  }

  return crypto.createHash("sha256").update(rawKey.trim(), "utf8").digest();
}

export function keyFromSecretMaterial(secret: string) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function getCurrentKey() {
  const source = requireKeySource();
  if (source === "master-key") {
    return keyFromMaterial(process.env[KEY_ENV_NAME] as string);
  }

  const fallback = process.env[FALLBACK_ENV_NAME];
  if (!fallback || !fallback.trim()) {
    throw new Error(`${KEY_ENV_NAME} or ${FALLBACK_ENV_NAME} is required to encrypt stored secrets`);
  }

  // Derive from the exact original string. Trimming here would silently change
  // the legacy key for deployments whose secret had surrounding whitespace.
  return keyFromSecretMaterial(fallback);
}

export function decryptWithKey(encryptedSecret: string, key: Buffer) {
  const rawPayload = isVersionedSecret(encryptedSecret)
    ? encryptedSecret.slice(SECRET_CIPHER_VERSION_PREFIX.length)
    : encryptedSecret;
  const payload = Buffer.from(rawPayload, "base64");
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function encryptWithKey(secret: string, key: Buffer) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return (
    SECRET_CIPHER_VERSION_PREFIX +
    Buffer.concat([iv, authTag, ciphertext]).toString("base64")
  );
}

export function encryptSecret(secret: string) {
  if (!secret.trim()) {
    throw new Error("Secret is required");
  }

  return encryptWithKey(secret, getCurrentKey());
}

export function decryptSecret(encryptedSecret: string) {
  return decryptWithKey(encryptedSecret, getCurrentKey());
}