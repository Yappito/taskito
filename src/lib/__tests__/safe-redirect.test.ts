import { describe, expect, it } from "vitest";

import { getSafeRedirectPath } from "../safe-redirect";

describe("getSafeRedirectPath", () => {
  it("allows same-origin relative paths", () => {
    expect(getSafeRedirectPath("/default?task=abc#comments")).toBe("/default?task=abc#comments");
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(getSafeRedirectPath("https://evil.example/phish")).toBe("/");
    expect(getSafeRedirectPath("//evil.example/phish")).toBe("/");
  });

  it("falls back for malformed or control-character paths", () => {
    expect(getSafeRedirectPath("/safe\nSet-Cookie:x", "/login")).toBe("/login");
    expect(getSafeRedirectPath(null, "/login")).toBe("/login");
  });
});
