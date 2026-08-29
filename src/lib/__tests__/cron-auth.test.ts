import { describe, expect, it } from "vitest";

import { cronSecretEquals, parseBearerAuthorization } from "@/lib/cron-auth";

describe("parseBearerAuthorization", () => {
  it("parses a Bearer token", () => {
    expect(parseBearerAuthorization("Bearer secret-value")).toBe("secret-value");
  });

  it("keeps interior spaces in the token but does not trim the tail (compared verbatim)", () => {
    expect(parseBearerAuthorization("Bearer   secret-value")).toBe("secret-value");
    // The token is compared verbatim against the configured secret; a trailing
    // space simply makes the lengths differ, which cronSecretEquals rejects.
    expect(parseBearerAuthorization("Bearer secret-value \t")).toBe("secret-value \t");
  });

  it("returns null for missing or non-Bearer headers", () => {
    expect(parseBearerAuthorization(null)).toBeNull();
    expect(parseBearerAuthorization("")).toBeNull();
    expect(parseBearerAuthorization("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseBearerAuthorization("Token abc")).toBeNull();
    expect(parseBearerAuthorization("Bearer")).toBeNull();
    expect(parseBearerAuthorization("Bearer ")).toBeNull();
  });
});

describe("cronSecretEquals (L12: constant-time comparison)", () => {
  const configured = "correct-horse-battery-staple";

  it("accepts the exact secret", () => {
    expect(cronSecretEquals(configured, configured)).toBe(true);
  });

  it("rejects a null (missing) token", () => {
    expect(cronSecretEquals(null, configured)).toBe(false);
  });

  it("rejects a wrong token of the same length", () => {
    expect(cronSecretEquals("wronge-horse-battery-staple", configured)).toBe(false);
  });

  it("rejects a wrong token of a different length (length mismatch short-circuits)", () => {
    expect(cronSecretEquals("x", configured)).toBe(false);
    expect(cronSecretEquals(`${configured}-longer`, configured)).toBe(false);
    expect(cronSecretEquals("", configured)).toBe(false);
  });

  it("does not throw on length mismatch (timingSafeEqual would)", () => {
    expect(() => cronSecretEquals("a", "bb")).not.toThrow();
  });
});
