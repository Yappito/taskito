import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

// Spy wrappers around the real argon2-backed helpers so tests can assert that
// verification calls happen (including dummy verifies) while still exercising
// the genuine implementations.
vi.mock("@/lib/password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/password")>();
  return {
    ...actual,
    hashPassword: vi.fn(actual.hashPassword),
    verifyPassword: vi.fn(actual.verifyPassword),
  };
});

import { hashPassword, verifyPassword } from "@/lib/password";
import { resetRateLimit } from "@/lib/rate-limit";
import {
  API_TOKEN_FAIL_RATE_LIMIT_BUCKET,
  API_TOKEN_LAST_USED_THROTTLE_MS,
  API_TOKEN_PREFIX,
  bearerSessionFromIdentity,
  generateApiTokenSecret,
  parseBearerApiToken,
  resolveBearerToken,
  type ApiTokenPrismaLike,
} from "@/server/services/api-tokens";
import { createPrismaMock, type PrismaMock } from "@/test/prisma-mock";

const verifyPasswordMock = verifyPassword as unknown as Mock;
const hashPasswordMock = hashPassword as unknown as Mock;

const USER_ID = "cmuser000000000000000000u0";
const OTHER_IP = "198.51.100.7";
const IP = "203.0.113.9";
const TOKEN_ID = "cmtok000000000000000000t1";
const NOW = Date.now();

interface StoredTokenOverrides {
  tokenHash?: string;
  userId?: string;
  lastUsedAt?: Date | null;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}

interface Seed {
  token: string;
  prisma: PrismaMock;
}

/** resolveBearerToken with the PrismaMock cast to the service's prisma surface. */
function resolve(prisma: PrismaMock, headers: Headers) {
  return resolveBearerToken(prisma as unknown as ApiTokenPrismaLike, headers);
}

/** Generates a real token and wires the prisma mock for it. */
async function seed(overrides: StoredTokenOverrides = {}): Promise<Seed> {
  const generated = await generateApiTokenSecret();
  const token = generated.token;

  const prisma = createPrismaMock();
  prisma.apiToken.findMany.mockResolvedValue([
    {
      id: TOKEN_ID,
      userId: overrides.userId ?? USER_ID,
      tokenHash: overrides.tokenHash ?? generated.tokenHash,
      lastUsedAt: overrides.lastUsedAt ?? null,
      expiresAt: overrides.expiresAt ?? null,
      revokedAt: overrides.revokedAt ?? null,
    },
  ]);
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID, role: "member", disabledAt: null });

  return { token, prisma };
}

function headersFor(token: string | null, ip: string = IP) {
  const headers = new Headers();
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (ip) {
    headers.set("x-real-ip", ip);
  }
  return headers;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimit(API_TOKEN_FAIL_RATE_LIMIT_BUCKET, IP);
  resetRateLimit(API_TOKEN_FAIL_RATE_LIMIT_BUCKET, OTHER_IP);
});

describe("api token format", () => {
  it("generates tk_ tokens with 43 base64url characters of secret", async () => {
    const generated = await generateApiTokenSecret();

    expect(generated.token.startsWith(`${API_TOKEN_PREFIX}`)).toBe(true);
    expect(generated.token).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    expect(generated.token).toHaveLength(46);
  });

  it("derives the prefix from the first 8 characters of the token", async () => {
    const first = await generateApiTokenSecret();
    const second = await generateApiTokenSecret();

    expect(first.tokenPrefix).toBe(first.token.slice(0, 8));
    expect(first.tokenPrefix).toHaveLength(8);
    expect(first.tokenPrefix.startsWith("tk_")).toBe(true);
    // Tokens are individually random.
    expect(first.token).not.toBe(second.token);
  });

  it("never returns the plaintext as the stored hash", async () => {
    hashPasswordMock.mockClear();
    const generated = await generateApiTokenSecret();

    expect(generated.tokenHash).toMatch(/^\$argon2id\$/);
    expect(generated.tokenHash).not.toContain(generated.token);
  });

  it("parses well-formed bearer headers and rejects everything else", () => {
    expect(parseBearerApiToken(`Bearer tk_${"A".repeat(43)}`)).toBe(`tk_${"A".repeat(43)}`);
    expect(parseBearerApiToken(`bearer tk_${"A".repeat(43)}`)).toBe(`tk_${"A".repeat(43)}`);
    expect(parseBearerApiToken(`Bearer   tk_${"A".repeat(43)}`)).toBe(`tk_${"A".repeat(43)}`);
    expect(parseBearerApiToken(`Bearer tk_${"A".repeat(42)}`)).toBeNull();
    expect(parseBearerApiToken(`Bearer tk_${"A".repeat(44)}`)).toBeNull();
    expect(parseBearerApiToken("Bearer not-a-token")).toBeNull();
    expect(parseBearerApiToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseBearerApiToken("Bearer")).toBeNull();
    expect(parseBearerApiToken(null)).toBeNull();
  });
});

describe("resolveBearerToken", () => {
  it("resolves a valid token to the user id and db role", async () => {
    const { token, prisma } = await seed({ userId: USER_ID });
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID, role: "admin", disabledAt: null });

    const identity = await resolve(prisma, headersFor(token));

    expect(identity).toEqual({ userId: USER_ID, role: "admin", authMethod: "token" });
    expect(prisma.apiToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenPrefix: token.slice(0, 8) } })
    );
  });

  it("returns null for a missing or empty header without touching the database", async () => {
    const prisma = createPrismaMock();

    await expect(resolve(prisma, headersFor(null))).resolves.toBeNull();
    await expect(resolve(prisma, new Headers())).resolves.toBeNull();
    expect(prisma.apiToken.findMany).not.toHaveBeenCalled();
  });

  it("ignores non-bearer schemes without rate limiting", async () => {
    const prisma = createPrismaMock();
    const headers = new Headers({ authorization: "Basic dXNlcjpwYXNz", "x-real-ip": IP });

    await expect(resolve(prisma, headers)).resolves.toBeNull();
    expect(verifyPasswordMock).not.toHaveBeenCalled();
    expect(prisma.apiToken.findMany).not.toHaveBeenCalled();
  });

  it("rejects a revoked token", async () => {
    const { token, prisma } = await seed({ revokedAt: new Date(NOW - 1000) });

    await expect(resolve(prisma, headersFor(token))).resolves.toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.apiToken.update).not.toHaveBeenCalled();
  });

  it("rejects an expired token but allows one that is still valid", async () => {
    const expired = await seed({ expiresAt: new Date(Date.now() - 1000) });
    await expect(resolve(expired.prisma, headersFor(expired.token))).resolves.toBeNull();

    const valid = await seed({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) });
    await expect(resolve(valid.prisma, headersFor(valid.token))).resolves.toMatchObject({
      userId: USER_ID,
    });
  });

  it("rejects a disabled user and a missing user", async () => {
    const disabled = await seed();
    disabled.prisma.user.findUnique.mockResolvedValue({
      id: USER_ID,
      role: "member",
      disabledAt: new Date(NOW - 60 * 60 * 1000),
    });
    await expect(resolve(disabled.prisma, headersFor(disabled.token))).resolves.toBeNull();

    const missing = await seed();
    missing.prisma.user.findUnique.mockResolvedValue(null);
    await expect(resolve(missing.prisma, headersFor(missing.token))).resolves.toBeNull();
  });

  it("rejects a wrong secret even when the prefix matches a stored token", async () => {
    const { token, prisma } = await seed();
    const wrongSecretToken = `${token.slice(0, 8)}${"z".repeat(43)}`.slice(0, 46);

    await expect(resolve(prisma, headersFor(wrongSecretToken))).resolves.toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.apiToken.update).not.toHaveBeenCalled();
  });

  it("still runs one dummy argon2 verify for an unknown prefix", async () => {
    const unknownToken = `tk_${"u".repeat(43)}`;
    const prisma = createPrismaMock();
    prisma.apiToken.findMany.mockResolvedValue([]);

    verifyPasswordMock.mockClear();
    await expect(resolve(prisma, headersFor(unknownToken))).resolves.toBeNull();

    expect(prisma.apiToken.findMany).toHaveBeenCalledOnce();
    expect(verifyPasswordMock).toHaveBeenCalledOnce();
    // The single verification ran against an argon2id hash (the embedded dummy
    // hash — there were no stored candidates to compare against).
    expect(verifyPasswordMock).toHaveBeenCalledWith(expect.any(String), expect.stringContaining("$argon2id$"));
    expect(prisma.apiToken.update).not.toHaveBeenCalled();
  });

  it("updates lastUsedAt when it was never set", async () => {
    const { token, prisma } = await seed({ lastUsedAt: null });

    await resolve(prisma, headersFor(token));

    expect(prisma.apiToken.update).toHaveBeenCalledOnce();
    expect(prisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: TOKEN_ID },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("throttles lastUsedAt writes to at most once per minute per token", async () => {
    const recent = await seed({ lastUsedAt: new Date(Date.now() - 30 * 1000) });
    await resolve(recent.prisma, headersFor(recent.token));
    expect(recent.prisma.apiToken.update).not.toHaveBeenCalled();

    const stale = await seed({ lastUsedAt: new Date(Date.now() - (API_TOKEN_LAST_USED_THROTTLE_MS + 5000)) });
    await resolve(stale.prisma, headersFor(stale.token));
    expect(stale.prisma.apiToken.update).toHaveBeenCalledOnce();
  });

  it("rate limits failed bearer attempts per IP", async () => {
    const { token, prisma } = await seed();
    const wrongSecretToken = `tk_${"f".repeat(43)}`;

    // The first failure fills the per-IP budget (10 attempts), then even a
    // valid token from the same IP is rejected until the window passes.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(resolve(prisma, headersFor(wrongSecretToken))).resolves.toBeNull();
    }

    prisma.user.findUnique.mockClear();
    await expect(resolve(prisma, headersFor(token))).resolves.toBeNull();
    // The exhausted bucket short-circuits before any user work happens.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();

    // A different IP is unaffected.
    const other = await seed();
    await expect(resolve(other.prisma, headersFor(other.token, OTHER_IP))).resolves.toMatchObject({
      userId: USER_ID,
    });
  });

  it("clears the failure bucket after a successful resolution", async () => {
    const { token, prisma } = await seed();

    // Nine failed attempts leave exactly one slot in the window budget.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      await expect(resolve(prisma, headersFor(wrongTokenFor(token)))).resolves.toBeNull();
    }

    // The successful resolution resets the bucket entirely...
    await expect(resolve(prisma, headersFor(token))).resolves.toMatchObject({ userId: USER_ID });

    // ...so a subsequent failure is verified again rather than rate-limited away.
    verifyPasswordMock.mockClear();
    await expect(resolve(prisma, headersFor(wrongTokenFor(token)))).resolves.toBeNull();
    expect(verifyPasswordMock).toHaveBeenCalledTimes(1);
  });

  describe("bearerSessionFromIdentity", () => {
    it("maps an identity onto the shared session shape", () => {
      const session = bearerSessionFromIdentity({ userId: USER_ID, role: "member", authMethod: "token" });

      expect(session).toEqual({
        user: { id: USER_ID, role: "member" },
        expires: "",
        authMethod: "token",
      });
    });
  });
});

function wrongTokenFor(token: string) {
  return `${token.slice(0, 8)}${"q".repeat(43)}`.slice(0, 46);
}