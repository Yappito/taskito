import { lookup } from "node:dns/promises";

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

function assertHostnameIsConnectable(hostname: string) {
  if (isPrivateOrReservedHostname(hostname) && !allowPrivateProviderHosts()) {
    throw new Error(
      "Provider base URL points at a private, loopback, or link-local address. Enable AI_PROVIDER_ALLOW_PRIVATE_HOSTS or allowlist the host explicitly for self-hosted providers"
    );
  }
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

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Provider base URL must use HTTP or HTTPS");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Provider base URL must not include credentials");
  }

  const allowedHosts = getAllowedHosts();
  if (allowedHosts.length > 0 && !allowedHosts.includes(hostname)) {
    throw new Error("Provider host is not present in the allowlist");
  }

  // Private hosts on the allowlist were explicitly permitted in the step above.
  if (!allowedHosts.includes(hostname)) {
    assertHostnameIsConnectable(hostname);
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
    throw new Error("Provider host could not be resolved");
  }

  const hostIsAllowlisted = getAllowedHosts().includes(normalizeHostname(parsed.hostname));
  if (!allowPrivateProviderHosts() && !hostIsAllowlisted) {
    for (const { address } of addresses) {
      if (isPrivateIpv4Address(address) || isPrivateIpv6Address(address)) {
        throw new Error(
          `Provider host resolves to a private, loopback, or link-local address (${address}). Enable AI_PROVIDER_ALLOW_PRIVATE_HOSTS or allowlist the host explicitly for self-hosted providers`
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