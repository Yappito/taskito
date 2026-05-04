import { describe, expect, it } from "vitest";

import { getClientIpFromHeaders } from "../request-ip";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

describe("getClientIpFromHeaders", () => {
  it("prefers x-real-ip when present", () => {
    expect(
      getClientIpFromHeaders(headers({ "x-real-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.1" }))
    ).toBe("203.0.113.10");
  });

  it("uses the proxy-appended forwarded-for value", () => {
    expect(getClientIpFromHeaders(headers({ "x-forwarded-for": "198.51.100.1, 203.0.113.10" }))).toBe(
      "203.0.113.10"
    );
  });

  it("falls back to unknown for missing or invalid headers", () => {
    expect(getClientIpFromHeaders(headers({}))).toBe("unknown");
    expect(getClientIpFromHeaders(headers({ "x-real-ip": "198.51.100.1, 203.0.113.10" }))).toBe("unknown");
  });
});
