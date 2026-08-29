import crypto from "node:crypto";

const KEY_ENV_NAME = "AI_SECRET_MASTER_KEY";
const FALLBACK_ENV_NAME = "AUTH_SECRET";
const FALLBACK_ALLOWED_ENV_NAME = "AI_ALLOW_AUTH_SECRET_FALLBACK";
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

  const isProduction = process.env.NODE_ENV === "production";
  const fallbackAllowed = process.env[FALLBACK_ALLOWED_ENV_NAME] === "true";

  if (isProduction && !fallbackAllowed) {
    throw new Error(
      `${KEY_ENV_NAME} must be set in production to encrypt/decrypt stored secrets. ` +
        `Set it to a base64-encoded 32-byte key, or explicitly set ${FALLBACK_ALLOWED_ENV_NAME}=true ` +
        `to keep deriving it from ${FALLBACK_ENV_NAME} (not recommended: rotating ${FALLBACK_ENV_NAME} ` +
        `then invalidates stored secrets).`,
    );
  }

  if (!warnedAboutAuthSecretFallback) {
    warnedAboutAuthSecretFallback = true;
    const reason =
      isProduction && fallbackAllowed
        ? `${FALLBACK_ALLOWED_ENV_NAME}=true is set`
        : "no master key is configured";
    console.warn(
      `[secret-crypto] ${KEY_ENV_NAME} is not set; deriving the secret encryption key from ` +
        `${FALLBACK_ENV_NAME} because ${reason}. Set ${KEY_ENV_NAME} to a base64-encoded 32-byte key, ` +
        `then rotate existing ciphertext with \`npm run db:reencrypt-ai-secrets\`.`,
    );
  }

  return "auth-secret-fallback";
}

export function keyFromBase64Material(rawKey: string, envName = KEY_ENV_NAME) {
  const key = Buffer.from(rawKey.trim(), "base64");
  if (key.length !== 32) {
    throw new Error(`${envName} must be a base64-encoded 32-byte key`);
  }

  return key;
}

export function keyFromSecretMaterial(secret: string) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function getCurrentKey() {
  const source = requireKeySource();
  if (source === "master-key") {
    return keyFromBase64Material(process.env[KEY_ENV_NAME] as string);
  }

  const fallback = process.env[FALLBACK_ENV_NAME]?.trim();
  if (!fallback) {
    throw new Error(`${KEY_ENV_NAME} or ${FALLBACK_ENV_NAME} is required to encrypt stored secrets`);
  }

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