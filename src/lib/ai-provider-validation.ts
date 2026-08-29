import { lookup } from "node:dns/promises";
import type { LookupFunction } from "node:net";

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

/** Same class as {@link AiProviderUrlValidationError}; generic alias for non-AI egress paths. */
export { AiProviderUrlValidationError as OutboundUrlValidationError };

export interface OutboundUrlPolicy {
  /** Noun used in error messages (e.g. "Webhook URL"). Defaults to "Outbound URL". */
  label?: string;
  /** When true, loopback/private/link-local targets are permitted (documented self-hosted opt-in). */
  allowPrivateHosts?: boolean;
  /** Hint appended to the private-host rejection (the caller's env-var name). */
  privateHostsHint?: string;
}

/** True for IPv4 dotted-quad / bare-number literals and IPv6 literals (containing a colon). */
function isIpLiteralHostname(hostname: string) {
  if (normalizeHostname(hostname).includes(":")) {
    return true;
  }
  return /^[0-9.]+$/.test(hostname) && hostname.includes(".");
}

/**
 * Generic outbound-URL gate shared by every Taskito egress path that does not
 * need the AI provider allowlist (webhooks, and future integrations).
 *
 * Validates that `rawUrl` is an absolute HTTP(S) URL without embedded
 * credentials and that its host is (or resolves to) a public address:
 *
 * - private/reserved IP literals are rejected up front (unless the caller's
 *   `allowPrivateHosts` opt-in is set — e.g. `WEBHOOK_ALLOW_PRIVATE_HOSTS=true`);
 * - hostnames are resolved (all A and AAAA records) and every resolved
 *   address is checked, so public-looking DNS names cannot tunnel to private
 *   space (DNS rebinding / SSRF);
 * - the same checks re-run at send time in callers that dispatch later, since
 *   DNS answers can change between validation and delivery.
 *
 * Returns the normalized URL (hash stripped). Does not apply any allowlist —
 * callers that need one should keep using the AI-provider helpers above.
 */
export async function assertOutboundUrlAllowed(rawUrl: string, policy: OutboundUrlPolicy = {}): Promise<string> {
  return (await validateOutboundUrl(rawUrl, policy)).url;
}

/**
 * A connection target whose resolved addresses have been validated and whose
 * connect target is pinned to one of those validated answers.
 */
export interface PinnedOutboundConnection {
  /** Original URL (hash stripped) — the hostname is preserved so the real request keeps its TLS SNI and Host header. */
  url: string;
  /** Normalized hostname (IPv6 literal brackets removed). */
  hostname: string;
  /**
   * The pre-validated address the connection must use, captured from the same
   * DNS answer set that was checked against the block rules. Null when no
   * resolution was required: an IP literal (cannot rebind), or the caller's
   * `allowPrivateHosts` opt-in (self-hosted targets whose operators accept
   * whatever their resolver returns).
   */
  pinned: { address: string; family: 4 | 6 } | null;
}

/**
 * Outbound gate for requests that actually leave the process (webhook
 * delivery, integrations). Same rules as {@link assertOutboundUrlAllowed},
 * but instead of stopping at re-validation it also returns a pinned connect
 * target: feed {@link createPinnedOutboundLookup} into the HTTP(s) agent so
 * the connection can never re-resolve to a different (possibly private)
 * address between validation and TCP connect — the DNS-rebinding TOCTOU that
 * a plain `fetch(url)` would re-open after this check.
 */
export async function assertOutboundRequestPinned(
  rawUrl: string,
  policy: OutboundUrlPolicy = {},
): Promise<PinnedOutboundConnection> {
  return validateOutboundUrl(rawUrl, policy);
}

/**
 * Builds the `lookup` override that pins a connection to the validated
 * address. Every lookup the agent performs returns exactly the pre-validated
 * answer — never a fresh resolution — so connect-time DNS cannot steer the
 * request into private space. Returns undefined when the connection has no
 * pinned target (IP literal / allowPrivateHosts) and normal resolution is
 * acceptable.
 */
export function createPinnedOutboundLookup(connection: PinnedOutboundConnection): LookupFunction | undefined {
  const pinned = connection.pinned;
  if (!pinned) {
    return undefined;
  }
  return ((hostname, options, callback) => {
    // Deliberately ignores `hostname`: the entire point of the pin is that the
    // connect-time resolution cannot differ from the validated one.
    if (options?.all) {
      callback(null, [{ address: pinned.address, family: pinned.family }], pinned.family);
    } else {
      callback(null, pinned.address, pinned.family);
    }
  }) as LookupFunction;
}

/** Core URL + DNS validation shared by the URL-only and pinned variants. */
async function validateOutboundUrl(rawUrl: string, policy: OutboundUrlPolicy): Promise<PinnedOutboundConnection> {
  const label = policy.label ?? "Outbound URL";
  const trimmedUrl = rawUrl.trim();
  if (!trimmedUrl) {
    throw new AiProviderUrlValidationError(`${label} is required`);
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    throw new AiProviderUrlValidationError(`${label} must be a valid absolute URL`);
  }

  if (!httpOrHttps(parsed.protocol)) {
    throw new AiProviderUrlValidationError(`${label} must use HTTP or HTTPS`);
  }

  if (parsed.username || parsed.password) {
    throw new AiProviderUrlValidationError(`${label} must not include credentials`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  const allowPrivateHosts = policy.allowPrivateHosts === true;

  if (!allowPrivateHosts && isPrivateOrReservedHostname(hostname)) {
    throw new AiProviderUrlValidationError(
      `${label} points at a private, loopback, or link-local address${
        policy.privateHostsHint ? `. ${policy.privateHostsHint}` : ""
      }`,
    );
  }

  // Only hostnames need resolving: IP literals (and the private-host case
  // above) have already been checked against the reserved ranges.
  if (!allowPrivateHosts && !isIpLiteralHostname(hostname)) {
    const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) {
      throw new AiProviderUrlValidationError(`${label} host could not be resolved`);
    }
    for (const { address } of addresses) {
      if (isPrivateIpv4Address(address) || isPrivateIpv6Address(address)) {
        throw new AiProviderUrlValidationError(
          `${label} host resolves to a private, loopback, or link-local address (${address})${
            policy.privateHostsHint ? `. ${policy.privateHostsHint}` : ""
          }`,
        );
      }
    }
    // Pin the connection to one of the answers we just validated, so the real
    // request connects to THIS address regardless of what DNS says later
    // (DNS-rebinding TOCTOU). Prefer an IPv4 answer; fall back to the first.
    const chosen = addresses.find((answer) => answer.family === 4) ?? addresses[0];
    parsed.hash = "";
    return {
      url: parsed.toString(),
      hostname,
      pinned: { address: chosen.address, family: chosen.family as 4 | 6 },
    };
  }

  parsed.hash = "";
  // No resolution happened (IP literal or the private-host opt-in): nothing to
  // pin — an IP literal cannot rebind, and opted-in callers accept whatever
  // their resolver returns.
  return { url: parsed.toString(), hostname, pinned: null };
}

function httpOrHttps(protocol: string) {
  return protocol === "http:" || protocol === "https:";
}

export async function assertAiProviderBaseUrlFetchAllowed(rawUrl: string) {
  const normalizedUrl = normalizeBaseUrl(rawUrl);
  const parsed = new URL(normalizedUrl);
  // L11: URL.hostname keeps the brackets of an IPv6 literal (`[::1]`); the
  // DNS lookup must receive the bare address, or `http://[::1]:11434` fails
  // with a resolver error instead of being evaluated normally.
  const hostname = normalizeHostname(parsed.hostname);

  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new AiProviderUrlValidationError("Provider host could not be resolved");
  }

  // M5: when DNS resolves into private/reserved space, a bare (host-only)
  // allowlist entry is NOT enough — the exact `host:port` entry is required
  // (or the global AI_PROVIDER_ALLOW_PRIVATE_HOSTS override). A hostname-only
  // match must never suppress the resolved-address check, otherwise a bare
  // entry plus a private DNS answer re-opens every port on an internal host.
  const port = effectiveUrlPort(parsed);
  const entries = getAllowlistEntries();
  const explicitlyAllowedPort = allowlistExplicitlyAllowsPort(entries, hostname, port);
  if (!allowPrivateProviderHosts() && !explicitlyAllowedPort) {
    for (const { address } of addresses) {
      if (isPrivateIpv4Address(address) || isPrivateIpv6Address(address)) {
        throw new AiProviderUrlValidationError(
          `Provider host resolves to a private, loopback, or link-local address (${address}). Enable AI_PROVIDER_ALLOW_PRIVATE_HOSTS or allowlist the host with an exact \`host:port\` entry (e.g. ${hostname}:${port}) for self-hosted providers`,
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