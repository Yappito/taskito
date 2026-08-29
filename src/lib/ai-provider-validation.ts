import { lookup } from "node:dns/promises";

/**
 * Typed error thrown when a provider base URL (or a redirect target reached
 * through one) fails validation. The message is authored by Taskito and at
 * most echoes the operator's own hostname and resolved addresses — never
 * upstream response body bytes — so callers may surface it verbatim.
 */
export class AiProviderUrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderUrlValidationError";
  }
}

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

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/^\[(.*)]$/, "$1");
}

/**
 * One allowlist entry. Entries may be `host` (matches any port, but never
 * authorizes private hosts on its own) or `host:port` (matches exactly one
 * effective TCP port and is required to opt private hosts in).
 */
export interface AiProviderAllowlistEntry {
  hostname: string;
  /** Explicit port from a `host:port` entry, or null for a hostname-only entry. */
  port: number | null;
}

let allowlistCache: { signature: string; entries: AiProviderAllowlistEntry[] } | null = null;

/**
 * Parses `AI_PROVIDER_HOST_ALLOWLIST` (comma-separated `host` or `host:port`
 * entries, IPv6 literals bracketed). Entries are cached per env value so a
 * malformed entry warns exactly once; invalid entries are dropped, which fails
 * closed (the hosts they would have matched are simply not allowlisted).
 */
function getAllowlistEntries(): AiProviderAllowlistEntry[] {
  const raw = process.env.AI_PROVIDER_HOST_ALLOWLIST;
  const signature = raw ?? "";
  if (allowlistCache?.signature === signature) {
    return allowlistCache.entries;
  }

  const entries: AiProviderAllowlistEntry[] = [];
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim();
    if (!value) {
      continue;
    }
    const entry = parseAllowlistEntry(value);
    if (entry) {
      entries.push(entry);
    } else {
      console.warn(
        `[ai-provider-validation] Ignoring invalid AI_PROVIDER_HOST_ALLOWLIST entry "${value}" ` +
          "(expected `host` or `host:port`; port must be 1-65535)",
      );
    }
  }

  allowlistCache = { signature, entries };
  return entries;
}

function parseAllowlistEntry(value: string): AiProviderAllowlistEntry | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  // Bracketed IPv6: `[::1]` or `[::1]:11434`.
  if (normalized.startsWith("[")) {
    const close = normalized.indexOf("]");
    if (close < 0) {
      return null;
    }
    const hostname = normalized.slice(1, close);
    const rest = normalized.slice(close + 1);
    if (rest && !rest.startsWith(":")) {
      return null;
    }
    if (!rest) {
      return { hostname, port: null };
    }
    if (!/^\d+$/.test(rest.slice(1))) {
      return null;
    }
    const port = Number(rest.slice(1));
    if (port < 1 || port > 65535) {
      return null;
    }
    return { hostname: normalizeHostname(hostname), port };
  }

  // Hostnames, IPv4 literals, and `host:port` — none of which contain a colon.
  const colon = normalized.indexOf(":");
  if (colon < 0) {
    return { hostname: normalizeHostname(normalized), port: null };
  }
  if (!/^\d+$/.test(normalized.slice(colon + 1))) {
    return null;
  }
  const port = Number(normalized.slice(colon + 1));
  if (port < 1 || port > 65535) {
    return null;
  }
  return { hostname: normalizeHostname(normalized.slice(0, colon)), port };
}

/**
 * The TCP port a request will actually use: the explicit URL port, or the
 * scheme default (80 for HTTP, 443 for HTTPS).
 */
function effectiveUrlPort(parsed: URL): number {
  if (parsed.port) {
    return Number(parsed.port);
  }
  return parsed.protocol === "https:" ? 443 : 80;
}

/**
 * First allowlist entry matching `hostname` and the effective port. A bare
 * `host` entry matches any port (subject to the private-host gate below); a
 * `host:port` entry matches only that exact port.
 */
function matchingAllowlistEntry(
  entries: AiProviderAllowlistEntry[],
  hostname: string,
  port: number,
): AiProviderAllowlistEntry | null {
  return (
    entries.find((entry) => entry.hostname === hostname && (entry.port === null || entry.port === port)) ?? null
  );
}

function allowlistExplicitlyAllowsPort(
  entries: AiProviderAllowlistEntry[],
  hostname: string,
  port: number,
): boolean {
  return entries.some((entry) => entry.hostname === hostname && entry.port === port);
}

/**
 * Documented, self-hosted opt-in (Ollama / LM Studio / internal gateways).
 * Off by default: AI provider base URLs are not allowed to reach loopback,
 * private, or link-local targets.
 */
function allowPrivateProviderHosts() {
  return process.env.AI_PROVIDER_ALLOW_PRIVATE_HOSTS === "true";
}

function isPrivateIpv4Address(value: string) {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }

  const [first, second] = octets;
  return (
    first === 0 ||                                          // unspecified / this-network (0.0.0.0/8)
    first === 10 ||                                         // RFC1918 10/8
    first === 127 ||                                        // loopback 127/8
    (first === 100 && second >= 64 && second <= 127) ||     // CGNAT 100.64/10
    (first === 169 && second === 254) ||                    // link-local 169.254/16
    (first === 172 && second >= 16 && second <= 31) ||      // RFC1918 172.16/12
    (first === 192 && second === 168)                       // RFC1918 192.168/16
  );
}

/**
 * Expands an IPv6 literal (including `::` compression and an optional trailing
 * dotted-quad) into its 8 hextets, or returns null when the value is not IPv6.
 */
function expandIpv6Address(value: string): number[] | null {
  let address = value.trim().toLowerCase().replace(/%.*$/, "");

  if (!address.includes(":")) {
    return null;
  }

  // Convert a trailing dotted-quad (e.g. "::ffff:127.0.0.1") into two hextets.
  const lastColon = address.lastIndexOf(":");
  const lastGroup = address.slice(lastColon + 1);
  if (lastGroup.includes(".")) {
    const octets = lastGroup.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
      return null;
    }
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, lastColon + 1)}${high}:${low}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const missing = 8 - head.length - tail.length;

  if (halves.length === 2 && missing < 1) {
    return null;
  }
  if (halves.length === 1 && head.length !== 8) {
    return null;
  }

  const groups = halves.length === 2 ? [...head, ...Array<string>(missing).fill("0"), ...tail] : head;
  const hextets = groups.map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN));
  if (hextets.some((hextet) => Number.isNaN(hextet))) {
    return null;
  }

  return hextets;
}

function isPrivateIpv6Address(value: string) {
  const hextets = expandIpv6Address(value);
  if (!hextets) {
    return false;
  }

  // Unspecified (::) covers the all-zeros form; loopback is ::1.
  if (hextets.every((hextet) => hextet === 0)) {
    return true;
  }
  if (hextets.slice(0, 7).every((hextet) => hextet === 0) && hextets[7] === 1) {
    return true;
  }

  // IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::/96) forms:
  // evaluate the embedded IPv4 address with the IPv4 rules.
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && (hextets[5] === 0xffff || hextets[5] === 0)) {
    const ipv4 = [
      (hextets[6] >> 8) & 0xff,
      hextets[6] & 0xff,
      (hextets[7] >> 8) & 0xff,
      hextets[7] & 0xff,
    ].join(".");
    if (isPrivateIpv4Address(ipv4)) {
      return true;
    }
  }

  const first = hextets[0];
  return (
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xfe00) === 0xfc00    // unique-local fc00::/7
  );
}

/**
 * True when the hostname itself is a private/reserved IP literal or a name that
 * only ever refers to the local host. Hostnames that resolve to private
 * addresses are rejected separately at fetch time.
 */
export function isPrivateOrReservedHostname(hostname: string) {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return true;
  }
  if (isPrivateIpv4Address(normalized)) {
    return true;
  }
  return isPrivateIpv6Address(normalized);
}

function normalizeBaseUrl(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new AiProviderUrlValidationError("Provider base URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new AiProviderUrlValidationError("Provider base URL must be a valid absolute URL");
  }

  const hostname = normalizeHostname(parsed.hostname);

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new AiProviderUrlValidationError("Provider base URL must use HTTP or HTTPS");
  }

  if (parsed.username || parsed.password) {
    throw new AiProviderUrlValidationError("Provider base URL must not include credentials");
  }

  const entries = getAllowlistEntries();
  const port = effectiveUrlPort(parsed);

  if (entries.length > 0 && !matchingAllowlistEntry(entries, hostname, port)) {
    const hint =
      isPrivateOrReservedHostname(hostname) && entries.some((entry) => entry.hostname === hostname)
        ? " — private and loopback hosts require an exact `host:port` allowlist entry (e.g. localhost:11434)"
        : "";
    throw new AiProviderUrlValidationError(`Provider host is not present in the allowlist${hint}`);
  }

  // Private hosts: allowlisting a bare hostname no longer opens every TCP port
  // on that host. Only an exact `host:port` entry (or the global
  // AI_PROVIDER_ALLOW_PRIVATE_HOSTS override) authorizes a private target.
  const explicitlyAllowedPort = allowlistExplicitlyAllowsPort(entries, hostname, port);
  if (isPrivateOrReservedHostname(hostname) && !allowPrivateProviderHosts() && !explicitlyAllowedPort) {
    throw new AiProviderUrlValidationError(
      "Provider base URL points at a private, loopback, or link-local address. Allowlisting a private host requires an exact `host:port` entry (e.g. localhost:11434) or the AI_PROVIDER_ALLOW_PRIVATE_HOSTS=true override",
    );
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

  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new AiProviderUrlValidationError("Provider host could not be resolved");
  }

  const port = effectiveUrlPort(parsed);
  const hostIsAllowlisted = matchingAllowlistEntry(getAllowlistEntries(), normalizeHostname(parsed.hostname), port) !== null;
  if (!allowPrivateProviderHosts() && !hostIsAllowlisted) {
    for (const { address } of addresses) {
      if (isPrivateIpv4Address(address) || isPrivateIpv6Address(address)) {
        throw new AiProviderUrlValidationError(
          `Provider host resolves to a private, loopback, or link-local address (${address}). Enable AI_PROVIDER_ALLOW_PRIVATE_HOSTS or allowlist the host explicitly (use a \`host:port\` entry for private hosts) for self-hosted providers`,
        );
      }
    }
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