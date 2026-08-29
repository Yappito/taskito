/**
 * Pure string helpers describing the personal API token wire format.
 *
 * This module must stay dependency-free (no prisma, no argon2, no node:crypto):
 * it is imported by the Next.js middleware which runs in the Edge runtime.
 */

/** Every personal API token starts with this marker. */
export const API_TOKEN_PREFIX = "tk_";

/** Characters of the token persisted in cleartext for prefix lookup. */
export const API_TOKEN_PREFIX_LENGTH = 8;

/** The secret part of a token is 32 raw bytes encoded as unpadded base64url. */
export const API_TOKEN_SECRET_LENGTH = 43;

/** Matches the full token wire format: tk_<32 random bytes as base64url>. */
export const API_TOKEN_PATTERN = new RegExp(
  `^${API_TOKEN_PREFIX}[A-Za-z0-9_-]{${API_TOKEN_SECRET_LENGTH}}$`
);

/** Loose shape of a Taskito bearer header, used for the middleware look test. */
const API_TOKEN_LOOKS_LIKE_PATTERN = /^Bearer\s+tk_[A-Za-z0-9_-]{20,}$/i;

/**
 * Parses the `Authorization` header. Returns the full token only when the
 * header uses the Bearer scheme and the value matches the Taskito token
 * format (`tk_` + 43 base64url characters); otherwise null.
 */
export function parseBearerApiToken(authorizationHeader: string | null | undefined): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = authorizationHeader.trim().match(/^Bearer\s+(\S+)$/i);
  if (!match) {
    return null;
  }

  const token = match[1];
  if (!token.startsWith(API_TOKEN_PREFIX)) {
    return null;
  }
  // Full token = "tk_" (API_TOKEN_PREFIX.length) + API_TOKEN_SECRET_LENGTH secret chars.
  const expectedLength = API_TOKEN_PREFIX.length + API_TOKEN_SECRET_LENGTH;
  if (token.length !== expectedLength) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(token.slice(API_TOKEN_PREFIX.length))) {
    return null;
  }

  return token;
}

/** True when the header at least looks like a Taskito personal API token. */
export function looksLikeBearerApiToken(authorizationHeader: string | null | undefined): boolean {
  return typeof authorizationHeader === "string" && API_TOKEN_LOOKS_LIKE_PATTERN.test(authorizationHeader.trim());
}

/** True when the value matches the exact token wire format. */
export function isApiTokenFormat(token: string | null | undefined): boolean {
  return typeof token === "string" && API_TOKEN_PATTERN.test(token);
}