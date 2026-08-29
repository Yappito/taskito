import { describe, it, expect } from "vitest";
import { callbackUrl, emptyOidcProvider, parseAdminEmailText } from "../oidc-provider-form";

describe("parseAdminEmailText", () => {
  it("returns an empty list for blank input", () => {
    expect(parseAdminEmailText("")).toEqual([]);
    expect(parseAdminEmailText("  \n  ")).toEqual([]);
  });

  it("splits on newlines and commas and trims", () => {
    expect(parseAdminEmailText("a@example.com, b@example.com\nc@example.com")).toEqual([
      "a@example.com",
      "b@example.com",
      "c@example.com",
    ]);
  });

  it("lowercases entries and drops duplicates and empties", () => {
    expect(parseAdminEmailText("Bob@Example.com\nbob@example.com,,\nALICE@example.com")).toEqual([
      "bob@example.com",
      "alice@example.com",
    ]);
  });
});

describe("callbackUrl", () => {
  it("builds the callback url from origin and provider id", () => {
    expect(callbackUrl("https://tasks.example.com", "company-sso")).toBe(
      "https://tasks.example.com/api/auth/callback/company-sso"
    );
  });

  it("falls back to placeholders when origin or provider id are missing", () => {
    expect(callbackUrl("", "sso")).toBe("<app-url>/api/auth/callback/sso");
    expect(callbackUrl("https://tasks.example.com", "")).toBe(
      "https://tasks.example.com/api/auth/callback/<provider-id>"
    );
  });
});

describe("emptyOidcProvider", () => {
  it("matches the documented defaults", () => {
    expect(emptyOidcProvider).toEqual({
      providerId: "",
      name: "",
      issuer: "",
      clientId: "",
      clientSecret: "",
      scope: "openid email profile",
      groupsClaim: "groups",
      defaultRole: "member",
      allowSignup: true,
      allowEmailAccountLinking: false,
      requireEmailVerified: false,
      adminEmails: "",
      isEnabled: true,
    });
  });
});
