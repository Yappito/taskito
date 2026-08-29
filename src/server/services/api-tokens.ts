import { randomBytes } from "node:crypto";

import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import {
  API_TOKEN_PREFIX,
  API_TOKEN_PREFIX_LENGTH,
  parseBearerApiToken,
} from "@/lib/api-token-format";
import { hashPassword, verifyPassword } from "@/lib/password";
import { consumeRateLimit, resetRateLimit } from "@/lib/rate-limit";
import { getClientIpFromHeaders } from "@/lib/request-ip";

// Re-export the wire-format surface so server code can import everything
// token-related from this service.
export {
  API_TOKEN_PREFIX,
  API_TOKEN_PREFIX_LENGTH,
  API_TOKEN_SECRET_LENGTH,
  API_TOKEN_PATTERN,
  isApiTokenFormat,
  parseBearerApiToken,
} from "@/lib/api-token-format";

/** Random entropy of the secret part, in bytes (base64url-encoded). */
export const API_TOKEN_SECRET_BYTES = 32;

/** Minimum age of a lastUsedAt refresh, so a token storm cannot become a write storm. */
export const API_TOKEN_LAST_USED_THROTTLE_MS = 60_000;

/** Rate-limit bucket for failed bearer authentication attempts, keyed per client IP. */
export const API_TOKEN_FAIL_RATE_LIMIT_BUCKET = "api-token:fail";

const FAILED_BEARER_RATE_LIMIT = {
  maxAttempts: 10,
  windowMs: 15 * 60 * 1000,
} as const;

/**
 * Argon2id hash of an unrelated secret, using the same parameters as
 * {@link hashPassword}. Verifying against it on failed resolutions keeps
 * timing roughly constant whether or not a token with the requested prefix
 * exists, closing prefix-existence timing oracles.
 */
const DUMMY_API_TOKEN_HASH =
  "$argon2id$v=19$m=19456,t=3,p=1$Do0IDbY0tPmqGnvGU2myGA$emViSFP+5+Nhz4xn56wCcC2m0p9r4sOTM10ANi2hKEU";

/** Arbitrary secret verified against the dummy hash to equalize failure timing. */
const DUMMY_API_TOKEN_SECRET = "taskito-api-token-timing-equilizer";

/** Strict Prisma surface required by this service (mirrors the real client). */
export type ApiTokenPrismaLike = Pick<typeof prisma, "apiToken" | "user">;

export interface GeneratedApiToken {
  /** Full plaintext token, shown exactly once at creation. */
  token: string;
  /** First 8 characters of the full token; stored in cleartext for lookup. */
  tokenPrefix: string;
  /** Argon2id hash of the full token; only this is persisted. */
  tokenHash: string;
}

/** Identity resolved from a valid `Authorization: Bearer tk_…` header. */
export interface BearerTokenIdentity {
  userId: string;
  role: "admin" | "member";
  authMethod: "token";
}

/** Session-shaped value produced for a valid bearer request. */
export interface ApiTokenSession {
  user: {
    id: string;
    role: "admin" | "member";
  };
  expires: string;
  authMethod: "token";
}

export interface CreateTokenResult {
  id: string;
  name: string;
  tokenPrefix: string;
  expiresAt: Date | null;
  createdAt: Date;
  token: string;
}

export interface ListTokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

const TOKEN_LIST_SELECT = {
  id: true,
  name: true,
  tokenPrefix: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/**
 * Generates a fresh personal API token: `tk_<32 random bytes base64url>`.
 * The plaintext token is returned exactly once and only its hash should be
 * persisted.
 */
export async function generateApiTokenSecret(): Promise<GeneratedApiToken> {
  const secret = randomBytes(API_TOKEN_SECRET_BYTES).toString("base64url");
  const token = `${API_TOKEN_PREFIX}${secret}`;
  const tokenHash = await hashPassword(token);

  return {
    token,
    tokenPrefix: token.slice(0, API_TOKEN_PREFIX_LENGTH),
    tokenHash,
  };
}

/** Creates and stores a personal API token for the given user. */
export async function createApiTokenForUser(
  prismaClient: ApiTokenPrismaLike,
  userId: string,
  input: { name: string; expiresInDays?: number | null }
): Promise<CreateTokenResult> {
  const generated = await generateApiTokenSecret();

  const record = await prismaClient.apiToken.create({
    data: {
      userId,
      name: input.name,
      tokenPrefix: generated.tokenPrefix,
      tokenHash: generated.tokenHash,
      // v1: every token gets the wildcard scope; the column is reserved for
      // future fine-grained permissions.
      scopes: ["*"],
      ...(input.expiresInDays
        ? { expiresAt: new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000) }
        : {}),
    },
    select: { id: true, name: true, tokenPrefix: true, expiresAt: true, createdAt: true },
  });

  return { ...record, token: generated.token };
}

/** Lists the calling user's tokens — never includes the hash or any secret material. */
export async function listApiTokensForUser(
  prismaClient: ApiTokenPrismaLike,
  userId: string
): Promise<ListTokenRow[]> {
  return prismaClient.apiToken.findMany({
    where: { userId },
    select: TOKEN_LIST_SELECT,
    orderBy: { createdAt: "desc" },
  });
}

/** Revokes a token owned by the given user; returns false when no row matches. */
export async function revokeApiTokenForUser(
  prismaClient: ApiTokenPrismaLike,
  userId: string,
  tokenId: string
): Promise<boolean> {
  const token = await prismaClient.apiToken.findFirst({
    where: { id: tokenId, userId },
    select: { id: true },
  });
  if (!token) {
    return false;
  }

  await prismaClient.apiToken.update({
    where: { id: token.id },
    data: { revokedAt: new Date() },
  });
  return true;
}

/**
 * Maps a resolved bearer identity onto the same session shape used by
 * Auth.js cookie sessions (`{ user: { id, role } }`), tagged with
 * `authMethod: "token"`.
 */
export function bearerSessionFromIdentity(identity: BearerTokenIdentity): ApiTokenSession {
  return {
    user: { id: identity.userId, role: identity.role },
    expires: "",
    authMethod: "token",
  };
}

/** Type guard used by route handlers when merging cookie and token sessions. */
export function isApiTokenSession(session: Session | ApiTokenSession | null): session is ApiTokenSession {
  return !!session && (session as ApiTokenSession).authMethod === "token";
}

/**
 * Resolves the identity of an `Authorization: Bearer tk_…` header.
 *
 * - Parses and validates the token format.
 * - Looks up candidate tokens by their 8-character prefix.
 * - Verifies the argon2id hash; when no candidate matches the prefix, one
 *   verify against a dummy hash still runs so lookup timing does not reveal
 *   whether a prefix exists.
 * - Rejects revoked, expired and disabled-user tokens (role is re-read from
 *   the User record, never trusted from the token).
 * - Refreshes `lastUsedAt` at most once per minute per token.
 * - Rate limits failed bearer attempts per client IP via rate-limit.
 *
 * Returns null when the header is absent, not a bearer attempt, or invalid.
 */
export async function resolveBearerToken(
  prismaClient: ApiTokenPrismaLike,
  headers: Pick<Headers, "get">
): Promise<BearerTokenIdentity | null> {
  const authorization = headers.get("authorization");
  if (!authorization) {
    return null;
  }

  // Only the Bearer scheme participates in token resolution; other schemes
  // (e.g. Basic) are ignored so cookie-session handling stays untouched.
  const schemeMatch = authorization.trim().match(/^(\S+)\s/);
  if (!schemeMatch || schemeMatch[1].toLowerCase() !== "bearer") {
    return null;
  }

  const ip = getClientIpFromHeaders(headers);
  const limit = consumeRateLimit(API_TOKEN_FAIL_RATE_LIMIT_BUCKET, ip, FAILED_BEARER_RATE_LIMIT);
  if (!limit.allowed) {
    return null;
  }
  const fail = (): null => null;
  const succeed = (userId: string, role: "admin" | "member"): BearerTokenIdentity => {
    resetRateLimit(API_TOKEN_FAIL_RATE_LIMIT_BUCKET, ip);
    return { userId, role, authMethod: "token" };
  };

  const token = parseBearerApiToken(authorization);
  if (!token) {
    // Malformed bearer header: burn one argon2 verify so the timing of this
    // path matches the unknown-prefix path below.
    await verifyPassword(DUMMY_API_TOKEN_SECRET, DUMMY_API_TOKEN_HASH);
    return fail();
  }

  const tokenPrefix = token.slice(0, API_TOKEN_PREFIX_LENGTH);
  const candidates = await prismaClient.apiToken.findMany({
    where: { tokenPrefix },
    select: { id: true, userId: true, tokenHash: true, lastUsedAt: true, expiresAt: true, revokedAt: true },
  });

  let matched: {
    id: string;
    userId: string;
    tokenHash: string;
    lastUsedAt: Date | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  } | null = null;
  for (const candidate of candidates) {
    const verification = await verifyPassword(token, candidate.tokenHash);
    if (verification.valid) {
      matched = candidate;
      break;
    }
  }

  if (!matched) {
    // Unknown prefix or wrong secret: still exactly one argon2 verify happened
    // against the dummy hash when there were no candidates.
    if (candidates.length === 0) {
      await verifyPassword(DUMMY_API_TOKEN_SECRET, DUMMY_API_TOKEN_HASH);
    }
    return fail();
  }

  const now = Date.now();
  if (matched.revokedAt) {
    return fail();
  }
  if (matched.expiresAt && matched.expiresAt.getTime() <= now) {
    return fail();
  }

  const user = await prismaClient.user.findUnique({
    where: { id: matched.userId },
    select: { id: true, role: true, disabledAt: true },
  });
  if (!user || user.disabledAt) {
    return fail();
  }

  const identity = succeed(user.id, user.role === "admin" ? "admin" : "member");

  // Throttled lastUsedAt refresh: at most one write per token per minute.
  if (!matched.lastUsedAt || now - matched.lastUsedAt.getTime() >= API_TOKEN_LAST_USED_THROTTLE_MS) {
    try {
      await prismaClient.apiToken.update({
        where: { id: matched.id },
        data: { lastUsedAt: new Date(now) },
      });
    } catch {
      // A failed usage-tracking update must never fail the request.
    }
  }

  return identity;
}