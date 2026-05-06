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
