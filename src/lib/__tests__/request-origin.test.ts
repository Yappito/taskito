import { afterEach, describe, expect, it } from "vitest";

import { isTrustedRequestUrl } from "../request-origin";

function request(url: string, headerValues: Record<string, string> = {}) {
  return { url, headers: new Headers(headerValues) };
}

const PREVIOUS_AUTH_URL = process.env.AUTH_URL;

afterEach(() => {
  if (PREVIOUS_AUTH_URL === undefined) {
    delete process.env.AUTH_URL;
  } else {
    process.env.AUTH_URL = PREVIOUS_AUTH_URL;
  }
});

describe("isTrustedRequestUrl", () => {
  it("accepts the direct request origin", () => {
    const req = request("http://localhost:3001/api/ai/stream");
    expect(isTrustedRequestUrl(req, "http://localhost:3001")).toBe(true);
  });

  it("rejects a cross-site origin", () => {
    const req = request("http://localhost:3001/api/ai/stream");
    expect(isTrustedRequestUrl(req, "https://evil.example.com")).toBe(false);
  });

  it("accepts the public origin from forwarded host and proto headers", () => {
    const req = request("http://internal:3000/api/ai/stream", {
      "x-forwarded-host": "taskito.example.com",
      "x-forwarded-proto": "https",
    });
    expect(isTrustedRequestUrl(req, "https://taskito.example.com")).toBe(true);
  });

  it("still rejects cross-site origins when forwarding headers are present", () => {
    const req = request("http://internal:3000/api/ai/stream", {
      "x-forwarded-host": "taskito.example.com",
      "x-forwarded-proto": "https",
    });
    expect(isTrustedRequestUrl(req, "https://evil.example.com")).toBe(false);
  });

  it("falls back to the request protocol when x-forwarded-proto is missing", () => {
    const req = request("http://internal:3000/api/ai/stream", {
      "x-forwarded-host": "taskito.example.com",
    });
    expect(isTrustedRequestUrl(req, "http://taskito.example.com")).toBe(true);
    expect(isTrustedRequestUrl(req, "https://taskito.example.com")).toBe(false);
  });

  it("uses the first value from comma-separated forwarding headers", () => {
    const req = request("http://internal:3000/api/ai/stream", {
      "x-forwarded-host": "taskito.example.com, internal:3000",
      "x-forwarded-proto": "https, http",
    });
    expect(isTrustedRequestUrl(req, "https://taskito.example.com")).toBe(true);
  });

  it("accepts the AUTH_URL origin when no forwarding headers are set", () => {
    process.env.AUTH_URL = "https://taskito.example.com/";
    const req = request("http://internal:3000/api/ai/stream");
    expect(isTrustedRequestUrl(req, "https://taskito.example.com")).toBe(true);
    expect(isTrustedRequestUrl(req, "https://evil.example.com")).toBe(false);
  });

  it("returns false for an unparseable candidate URL", () => {
    const req = request("http://localhost:3001/api/ai/stream");
    expect(isTrustedRequestUrl(req, "not a url")).toBe(false);
  });

  it("returns false for a referer that only shares the host but not the origin", () => {
    const req = request("http://localhost:3001/api/ai/stream");
    expect(isTrustedRequestUrl(req, "http://localhost:9999/some/page")).toBe(false);
  });
});
