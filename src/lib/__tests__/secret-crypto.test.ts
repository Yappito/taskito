import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
const OTHER_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
const AUTH_SECRET = "auth-secret-used-for-signing-sessions";

type SecretCryptoModule = typeof import("@/lib/secret-crypto");

async function loadSecretCrypto(): Promise<SecretCryptoModule> {
  vi.resetModules();
  return import("@/lib/secret-crypto");
}

describe("secret-crypto", () => {
  beforeEach(() => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
    vi.stubEnv("NODE_ENV", "test");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("roundtrips secrets with a versioned v1 prefix", async () => {
    const { encryptSecret, decryptSecret } = await loadSecretCrypto();

    const encrypted = encryptSecret("super-secret-token");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(encrypted).not.toContain("super-secret-token");
    expect(decryptSecret(encrypted)).toBe("super-secret-token");
  });

  it("still decrypts legacy unprefixed ciphertext", async () => {
    const nodeCrypto = await import("node:crypto");
    const key = Buffer.from(MASTER_KEY, "base64");
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("legacy-secret", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");

    expect(legacy.startsWith("v1:")).toBe(false);

    const { decryptSecret, isVersionedSecret } = await loadSecretCrypto();
    expect(isVersionedSecret(legacy)).toBe(false);
    expect(decryptSecret(legacy)).toBe("legacy-secret");
  });

  it("still decrypts legacy unprefixed ciphertext produced by the auth-secret fallback", async () => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", "");

    const nodeCrypto = await import("node:crypto");
    const key = nodeCrypto
      .createHash("sha256")
      .update(AUTH_SECRET, "utf8")
      .digest();
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update("legacy-fallback-secret", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");

    const { decryptSecret, getSecretKeySource } = await loadSecretCrypto();
    expect(getSecretKeySource()).toBe("auth-secret-fallback");
    expect(legacy.startsWith("v1:")).toBe(false);
    expect(decryptSecret(legacy)).toBe("legacy-fallback-secret");
  });

  it("derives the fallback key from the exact AUTH_SECRET, including surrounding whitespace", async () => {
    const rawSecret = "  secret with surrounding spaces  ";
    vi.stubEnv("AI_SECRET_MASTER_KEY", "");
    vi.stubEnv("AUTH_SECRET", rawSecret);

    const nodeCrypto = await import("node:crypto");
    const rawKey = nodeCrypto.createHash("sha256").update(rawSecret, "utf8").digest();
    const trimmedKey = nodeCrypto.createHash("sha256").update(rawSecret.trim(), "utf8").digest();
    expect(rawKey.equals(trimmedKey)).toBe(false);

    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", rawKey, iv);
    const ciphertext = Buffer.concat([cipher.update("whitespace-padded-legacy", "utf8"), cipher.final()]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");

    const { decryptSecret } = await loadSecretCrypto();
    expect(decryptSecret(legacy)).toBe("whitespace-padded-legacy");
  });

  it("produces a fresh IV per encryption, so equal plaintexts never compare equal", async () => {
    const { encryptWithKey, decryptWithKey } = await loadSecretCrypto();
    const key = Buffer.alloc(32, 3);

    const first = encryptWithKey("same plaintext", key);
    const second = encryptWithKey("same plaintext", key);

    expect(first).not.toBe(second);
    expect(first.startsWith("v1:")).toBe(true);
    expect(decryptWithKey(first, key)).toBe("same plaintext");
    expect(decryptWithKey(second, key)).toBe("same plaintext");
  });

  it("rejects tampered ciphertext payloads", async () => {
    const { encryptWithKey, decryptWithKey, SECRET_CIPHER_VERSION_PREFIX } = await loadSecretCrypto();
    const key = Buffer.alloc(32, 5);

    const encrypted = encryptWithKey("tamper-me", key);
    const payload = Buffer.from(encrypted.slice(SECRET_CIPHER_VERSION_PREFIX.length), "base64");
    payload[payload.length - 1] ^= 0xff; // flip a ciphertext byte
    const tampered = SECRET_CIPHER_VERSION_PREFIX + payload.toString("base64");

    expect(() => decryptWithKey(tampered, key)).toThrow();
    // Sanity: the Buffer.from/base64 roundtrip cannot be what threw.
    expect(Buffer.from(tampered.slice(SECRET_CIPHER_VERSION_PREFIX.length), "base64")).toEqual(payload);
  });

  it("fails to decrypt when the master key differs", async () => {
    const { encryptSecret } = await loadSecretCrypto();
    const encrypted = encryptSecret("super-secret-token");

    vi.stubEnv("AI_SECRET_MASTER_KEY", OTHER_MASTER_KEY);

    const { decryptSecret } = await loadSecretCrypto();
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it("converts non-base64 master key material into a 32-byte key automatically", async () => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", "plain-token-not-base64");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { encryptSecret, decryptSecret } = await loadSecretCrypto();
    const encrypted = encryptSecret("super-secret-token");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe("super-secret-token");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("converting it automatically"),
    );

    // The conversion is deterministic: re-encrypting under the same raw value
    // stays readable, and a different value yields a different key.
    const reloaded = await loadSecretCrypto();
    expect(reloaded.decryptSecret(encrypted)).toBe("super-secret-token");

    vi.stubEnv("AI_SECRET_MASTER_KEY", "a-different-token");
    const other = await loadSecretCrypto();
    expect(() => other.decryptSecret(encrypted)).toThrow();
  });

  it("uses valid base64-encoded 32-byte keys as-is without warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { encryptSecret, decryptSecret } = await loadSecretCrypto();
    const encrypted = encryptSecret("super-secret-token");
    expect(decryptSecret(encrypted)).toBe("super-secret-token");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("falls back to AUTH_SECRET automatically in production and warns", async () => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", "");
    vi.stubEnv("NODE_ENV", "production");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { encryptSecret, decryptSecret } = await loadSecretCrypto();
    const encrypted = encryptSecret("super-secret-token");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(decryptSecret(encrypted)).toBe("super-secret-token");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("AI_SECRET_MASTER_KEY is not set in production"));
  });

  it("falls back to AUTH_SECRET outside production and warns only once per process", async () => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { encryptSecret, decryptSecret, getSecretKeySource } = await loadSecretCrypto();
    expect(getSecretKeySource()).toBe("auth-secret-fallback");

    const encrypted = encryptSecret("super-secret-token");
    expect(decryptSecret(encrypted)).toBe("super-secret-token");
    encryptSecret("another-secret");

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});