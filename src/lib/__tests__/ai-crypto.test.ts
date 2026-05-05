import { beforeEach, describe, expect, it } from "vitest";

import { decryptAiSecret, encryptAiSecret } from "@/lib/ai-crypto";

describe("ai-crypto", () => {
  beforeEach(() => {
    process.env.AI_SECRET_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  });

  it("encrypts and decrypts provider secrets", () => {
    const encrypted = encryptAiSecret("super-secret-token");
    expect(encrypted).not.toBe("super-secret-token");
    expect(decryptAiSecret(encrypted)).toBe("super-secret-token");
  });
});
