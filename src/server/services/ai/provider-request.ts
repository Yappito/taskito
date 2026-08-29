import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";

const DEFAULT_AI_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Error thrown when the upstream provider answers with a non-OK HTTP status.
 * Carries the status so callers can summarize failures without echoing the
 * upstream response body back to the client.
 */
export class UpstreamProviderError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "UpstreamProviderError";
    this.status = status;
  }
}

export function getAiProviderRequestTimeoutMs() {
  const rawValue = process.env.AI_PROVIDER_REQUEST_TIMEOUT_MS?.trim();
  if (!rawValue) {
    return DEFAULT_AI_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  const parsedValue = Number(rawValue);
  if (!Number.isFinite(parsedValue) || parsedValue < 1_000) {
    return DEFAULT_AI_PROVIDER_REQUEST_TIMEOUT_MS;
  }

  return Math.floor(parsedValue);
}

/**
 * Shared fetch entry point for all outbound AI provider requests.
 *
 * Re-validates the exact request URL (scheme, credentials, allowlist, and
 * private/resolved-address policy) immediately before dispatching, so SSRF
 * checks are enforced at fetch time and cannot be skipped between setup and
 * request. The DNS resolution is re-checked for all A and AAAA records.
 *
 * Note: the connection itself is not pinned to the validated address. Node 22's
 * global fetch does not expose a public Agent/dispatcher API and the npm
 * `undici` package is not a dependency, so `new Agent({ connect: { lookup } })`
 * is unavailable here. Re-validating immediately before the request keeps the
 * DNS-rebinding window minimal.
 */
export async function fetchAiProvider(url: string, init?: RequestInit): Promise<Response> {
  const validatedUrl = await assertAiProviderBaseUrlFetchAllowed(url);
  return fetch(validatedUrl, init);
}

export function normalizeAiProviderRequestError(error: unknown, timeoutMs: number) {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /aborted due to timeout/i.test(error.message)
    ) {
      return new Error(`AI provider request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`);
    }

    return error;
  }

  return new Error("AI provider request failed");
}