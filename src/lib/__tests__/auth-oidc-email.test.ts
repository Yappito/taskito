import { describe, expect, it, vi } from "vitest";

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() })),
}));
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }));
vi.mock("@auth/prisma-adapter", () => ({ PrismaAdapter: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/rate-limit", () => ({ consumeRateLimit: vi.fn(), resetRateLimit: vi.fn() }));
vi.mock("@/lib/request-ip", () => ({ getClientIpFromHeaders: vi.fn() }));
vi.mock("@/server/services/oidc-provider-settings", () => ({ getOidcProviderConfigs: vi.fn() }));

import { buildOidcProviders } from "../auth";

const oidcProvider = {
  id: "company-oidc",
  name: "Company SSO",
  issuer: "https://id.example.com",
  clientId: "client-id",
  clientSecret: "client-secret",
  scope: "openid email profile",
  groupsClaim: "groups",
  defaultRole: "member" as const,
  allowSignup: true,
  allowEmailAccountLinking: false,
  requireEmailVerified: false,
  adminEmails: new Set<string>(),
  source: "env" as const,
};

describe("OIDC profile mailbox validation", () => {
  const profile = (buildOidcProviders([oidcProvider])[0] as { profile: (input: Record<string, unknown>) => unknown }).profile;

  it("accepts an ordinary email claim", () => {
    expect(profile({ sub: "oidc-1", email: "Ada.Lovelace@example.com", name: "Ada" })).toMatchObject({
      id: "oidc-1",
      email: "ada.lovelace@example.com",
    });
  });

  it("rejects CRLF-injected email claims instead of trimming them into a valid User.email", () => {
    const injected = "victim@example.com>\r\nRCPT TO:<attacker@example.com";
    expect(() => profile({ sub: "oidc-1", email: injected })).toThrow(/OIDC profile email claim rejected: .*CR\/LF/);
    expect(() => profile({ sub: "oidc-1", email: "ada@example.com\r\n" })).toThrow(
      /OIDC profile email claim rejected: .*CR\/LF/
    );
  });
});
