import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/password";

describe("password", () => {
  it("hashes new passwords with Argon2id", async () => {
    const hashed = await hashPassword("taskito-password-2026");

    expect(hashed.startsWith("$argon2id$")).toBe(true);

    await expect(verifyPassword("taskito-password-2026", hashed)).resolves.toEqual({
      valid: true,
      needsRehash: false,
    });
  });

  it("marks legacy bcrypt hashes for rehash after a successful verification", async () => {
    const hashed = await bcrypt.hash("legacy-password-2026", 12);

    await expect(verifyPassword("legacy-password-2026", hashed)).resolves.toEqual({
      valid: true,
      needsRehash: true,
    });
  });

  it("rejects incorrect passwords", async () => {
    const hashed = await hashPassword("taskito-password-2026");

    await expect(verifyPassword("wrong-password-2026", hashed)).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });
});