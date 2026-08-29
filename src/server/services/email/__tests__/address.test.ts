import { describe, expect, it } from "vitest";

import {
  assertValidMailbox,
  encodeDisplayName,
  InvalidEmailAddressError,
  parseEmailAddress,
} from "../address";

/** The adversarial payload from the security review. */
const INJECTION_PAYLOAD = "victim@example.com>\r\nRCPT TO:<attacker@example.com";

describe("parseEmailAddress", () => {
  it("splits plain and display-name forms", () => {
    expect(parseEmailAddress("noreply@example.com")).toEqual({ address: "noreply@example.com" });
    expect(parseEmailAddress("Taskito Ops <ops@example.com>")).toEqual({
      address: "ops@example.com",
      name: "Taskito Ops",
    });
  });

  it("does not split values whose pre-angle part contains angle brackets", () => {
    // The poisoned split must not yield a "clean" address plus a name.
    const parsed = parseEmailAddress(INJECTION_PAYLOAD);
    expect(parsed.address).toBe(INJECTION_PAYLOAD);
  });
});

describe("assertValidMailbox", () => {
  it("accepts ordinary, tagged and long-but-legal addresses", () => {
    expect(assertValidMailbox("ada@example.com")).toEqual({ address: "ada@example.com" });
    expect(assertValidMailbox("Ada Lovelace <ada.lovelace+tag@sub.domain-x.co>")).toEqual({
      address: "ada.lovelace+tag@sub.domain-x.co",
      name: "Ada Lovelace",
    });
    expect(assertValidMailbox("a".repeat(64) + "@example.com").address).toBe("a".repeat(64) + "@example.com");
    expect(assertValidMailbox("a@b.c")).toEqual({ address: "a@b.c" });
    expect(assertValidMailbox("user@localhost").address).toBe("user@localhost");
    expect(assertValidMailbox("x@hyphens-are-fine.example")).toEqual({ address: "x@hyphens-are-fine.example" });
  });

  it("rejects the CRLF SMTP-command injection payload", () => {
    expect(() => assertValidMailbox(INJECTION_PAYLOAD)).toThrow(InvalidEmailAddressError);
    expect(() => assertValidMailbox(`${INJECTION_PAYLOAD}`)).toThrow(/CR\/LF/);
  });

  it("rejects the display-name variant that ends in a clean address", () => {
    expect(() => assertValidMailbox(`victim@example.com>\r\nRCPT TO:<attacker@example.com`)).toThrow(
      InvalidEmailAddressError
    );
  });

  it("rejects control characters, whitespace and specials in the address", () => {
    for (const bad of [
      "a@b\r.c",
      "a@b\nc",
      "a b@c.de",
      "a,<b@c.de",
      'a"b@c.de',
      "a;b@c.de",
      "a@b.c,d@e.f",
      "a<b@c.de",
      "a>@b.c",
      "(a)@b.c",
      "[a]@b.c",
      "@b.c",
      "a@",
      "a..b@c.de",
      ".a@c.de",
      "a.@b.c" + "",
    ]) {
      expect(() => assertValidMailbox(bad), `expected reject: ${JSON.stringify(bad)}`).toThrow(InvalidEmailAddressError);
    }
  });

  it("rejects over-long local parts and domains, and malformed labels", () => {
    expect(() => assertValidMailbox(`${"a".repeat(65)}@example.com`)).toThrow(/local part exceeds 64/);
    // A 254-char domain necessarily makes the whole address over-long too.
    expect(() => assertValidMailbox(`a@${"b".repeat(254)}.com`)).toThrow(/too long/);
    // The longest legal single-local-digit address (1 local + @ + 252 domain).
    expect(assertValidMailbox(`a@${"b".repeat(248)}.co`).address).toBe(`a@${"b".repeat(248)}.co`);
    expect(() => assertValidMailbox("a@-b.c")).toThrow(InvalidEmailAddressError);
    expect(() => assertValidMailbox("a@b-.c")).toThrow(InvalidEmailAddressError);
    expect(() => assertValidMailbox("a@b..c")).toThrow(/empty label/);
    expect(() => assertValidMailbox("a@b.c.")).toThrow(/trailing dot/);
  });

  it("rejects multiple @ signs and bare strings", () => {
    expect(() => assertValidMailbox("a@b@c.de")).toThrow(/exactly one @/);
    expect(() => assertValidMailbox("not-an-email")).toThrow(InvalidEmailAddressError);
    expect(() => assertValidMailbox("")).toThrow(/empty/);
  });

  it("never echoes the rejected value in the error message", () => {
    try {
      assertValidMailbox(INJECTION_PAYLOAD, "recipient address");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidEmailAddressError);
      const message = (error as Error).message;
      expect(message).not.toContain("victim@example.com");
      expect(message).not.toContain("attacker@example.com");
      expect(message).not.toContain("\r\n");
    }
  });
});

describe("encodeDisplayName", () => {
  it("passes plain names through unchanged", () => {
    expect(encodeDisplayName("Ada Lovelace")).toBe("Ada Lovelace");
  });

  it("strips CR/LF so display names can never add header lines", () => {
    // `:` is an ASCII special, so the surviving text is also quoted — either
    // way the CR/LF injection is gone (single header line, no colon atom).
    expect(encodeDisplayName("Ada\r\nBcc: x@y.z")).toBe('"Ada Bcc: x@y.z"');
    expect(encodeDisplayName("Ada\r\nRCPT")).toBe("Ada RCPT");
  });

  it("quotes ASCII specials (angle brackets, quotes, commas, semicolons)", () => {
    const encoded = encodeDisplayName('Bob "X" <b@x>, ;y');
    expect(encoded).toBe('"Bob \\"X\\" <b@x>, ;y"');
  });

  it("RFC 2047 encodes non-ASCII names", () => {
    const encoded = encodeDisplayName("Ada Lövelace");
    expect(encoded).toMatch(/=\?UTF-8\?B\?/);
    expect(encoded).not.toContain("ö");
  });
});
