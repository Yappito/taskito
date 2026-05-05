import crypto from "node:crypto";

const KEY_ENV_NAME = "AI_SECRET_MASTER_KEY";
const FALLBACK_ENV_NAME = "AUTH_SECRET";
const IV_LENGTH = 12;

function getMasterKey() {
  const rawKey = process.env[KEY_ENV_NAME];
  if (!rawKey) {
    const fallback = process.env[FALLBACK_ENV_NAME];
    if (!fallback) {
      throw new Error(`${KEY_ENV_NAME} or ${FALLBACK_ENV_NAME} is required to encrypt AI provider secrets`);
    }

    return crypto.createHash("sha256").update(fallback, "utf8").digest();
  }

  const key = Buffer.from(rawKey, "base64");
  if (key.length !== 32) {
    throw new Error(`${KEY_ENV_NAME} must be a base64-encoded 32-byte key`);
  }

  return key;
}

export function encryptAiSecret(secret: string) {
  if (!secret.trim()) {
    throw new Error("Provider secret is required");
  }

  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptAiSecret(encryptedSecret: string) {
  const payload = Buffer.from(encryptedSecret, "base64");
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = payload.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
