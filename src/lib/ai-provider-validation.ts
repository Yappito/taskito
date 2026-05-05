import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DISALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);
const RESERVED_HEADER_NAMES = new Set([
  "accept",
  "authorization",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
  "anthropic-version",
]);

function getAllowedHosts() {
  return process.env.AI_PROVIDER_HOST_ALLOWLIST
    ?.split(",")
    .map((value) => normalizeHostname(value))
    .filter(Boolean) ?? [];
}

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[(.*)]$/, "$1");
}

function isAllowlistedHost(hostname: string) {
  return getAllowedHosts().includes(normalizeHostname(hostname));
}

function isPrivateOrReservedIpv4(address: string) {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }

  const [a, b, c] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPrivateOrReservedIpv6(address: string) {
  const normalized = normalizeHostname(address);
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:169.254.") ||
    normalized.startsWith("::ffff:172.16.") ||
    normalized.startsWith("::ffff:172.17.") ||
    normalized.startsWith("::ffff:172.18.") ||
    normalized.startsWith("::ffff:172.19.") ||
    normalized.startsWith("::ffff:172.20.") ||
    normalized.startsWith("::ffff:172.21.") ||
    normalized.startsWith("::ffff:172.22.") ||
    normalized.startsWith("::ffff:172.23.") ||
    normalized.startsWith("::ffff:172.24.") ||
    normalized.startsWith("::ffff:172.25.") ||
    normalized.startsWith("::ffff:172.26.") ||
    normalized.startsWith("::ffff:172.27.") ||
    normalized.startsWith("::ffff:172.28.") ||
    normalized.startsWith("::ffff:172.29.") ||
    normalized.startsWith("::ffff:172.30.") ||
    normalized.startsWith("::ffff:172.31.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("2001:db8")
  );
}

function isPrivateOrReservedIp(address: string) {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);
  if (version === 4) {
    return isPrivateOrReservedIpv4(normalized);
  }
  if (version === 6) {
    return isPrivateOrReservedIpv6(normalized);
  }
  return true;
}

function normalizeBaseUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new Error("Provider base URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Provider base URL must be a valid absolute URL");
  }

  const hostname = normalizeHostname(parsed.hostname);
  const isAllowlisted = isAllowlistedHost(hostname);

  if (DISALLOWED_HOSTS.has(hostname)) {
    throw new Error("Loopback provider hosts are not allowed in hosted deployments");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Provider base URL must use HTTP or HTTPS");
  }

  if (!isAllowlisted && parsed.protocol !== "https:") {
    throw new Error("Provider base URL must use HTTPS unless its host is explicitly allowlisted");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Provider base URL must not include credentials");
  }

  const allowedHosts = getAllowedHosts();
  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    throw new Error("Provider host is not present in the allowlist");
  }

  if (!isAllowlisted && isIP(hostname) && isPrivateOrReservedIp(hostname)) {
    throw new Error("Provider base URL must not target private or reserved IP ranges");
  }

  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

export function validateAiProviderBaseUrl(rawUrl: string) {
  return normalizeBaseUrl(rawUrl);
}

export async function assertAiProviderBaseUrlFetchAllowed(rawUrl: string) {
  const normalizedUrl = normalizeBaseUrl(rawUrl);
  const parsed = new URL(normalizedUrl);
  const hostname = normalizeHostname(parsed.hostname);

  if (isAllowlistedHost(hostname)) {
    return normalizedUrl;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error("Provider host could not be resolved");
  }

  if (addresses.some((address) => isPrivateOrReservedIp(address.address))) {
    throw new Error("Provider host resolves to a private or reserved IP range");
  }

  return normalizedUrl;
}

export function normalizeAiProviderModel(model: string) {
  const trimmed = model.trim();
  if (!trimmed) {
    throw new Error("Provider model is required");
  }
  if (trimmed.length > 200) {
    throw new Error("Provider model is too long");
  }
  return trimmed;
}

export function normalizeAiProviderHeaders(headers: unknown) {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return {} as Record<string, string>;
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      continue;
    }

    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(normalizedKey)) {
      throw new Error(`Provider header "${normalizedKey}" is not a valid HTTP header name`);
    }

    if (RESERVED_HEADER_NAMES.has(normalizedKey.toLowerCase())) {
      throw new Error(`Provider header "${normalizedKey}" is managed by Taskito and cannot be overridden`);
    }

    if (typeof value !== "string") {
      throw new Error(`Provider header "${normalizedKey}" must be a string`);
    }

    const normalizedValue = value.trim();
    if (/[\r\n]/.test(normalizedValue)) {
      throw new Error(`Provider header "${normalizedKey}" must not contain line breaks`);
    }

    result[normalizedKey] = normalizedValue;
  }

  return result;
}
