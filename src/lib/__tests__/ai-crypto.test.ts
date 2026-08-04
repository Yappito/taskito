import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptAiSecret, encryptAiSecret } from "@/lib/ai-crypto";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ai-crypto", () => {
  beforeEach(() => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
    vi.stubEnv("AUTH_SECRET", "");
  });

  it("encrypts and decrypts provider secrets", () => {
    const encrypted = encryptAiSecret("super-secret-token");
    expect(encrypted).not.toBe("super-secret-token");
    expect(decryptAiSecret(encrypted)).toBe("super-secret-token");
  });

  it("throws in production when AI_SECRET_MASTER_KEY is not set", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AI_SECRET_MASTER_KEY", "");

    expect(() => encryptAiSecret("super-secret-token")).toThrow(/AI_SECRET_MASTER_KEY is required in production/);
  });

  it("falls back to SHA256(AUTH_SECRET) in development with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_SECRET_MASTER_KEY", "");
    vi.stubEnv("AUTH_SECRET", "auth-secret-for-fallback");

    const encrypted = encryptAiSecret("super-secret-token");
    expect(decryptAiSecret(encrypted)).toBe("super-secret-token");
    expect(warnSpy).toHaveBeenCalledWith(
      "AI_SECRET_MASTER_KEY is not set; falling back to SHA256(AUTH_SECRET) for secret encryption"
    );
  });

  it("throws when neither key is available", () => {
    vi.stubEnv("AI_SECRET_MASTER_KEY", "");
    vi.stubEnv("AUTH_SECRET", "");

    expect(() => encryptAiSecret("super-secret-token")).toThrow(/AI_SECRET_MASTER_KEY or AUTH_SECRET is required/);
  });
});
