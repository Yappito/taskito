import { assertAiProviderBaseUrlFetchAllowed } from "@/lib/ai-provider-validation";

import type { AiNativeToolCall } from "./tools";

const DEFAULT_AI_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

/**
 * Statuses that are worth retrying with backoff (timeouts, conflicts, rate
 * limits, transient upstream failures). 401/403 and client errors like
 * 400/422 are permanent and are never retried.
 */
export const AI_PROVIDER_RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/**
 * Provider-supplied error messages are surfaced verbatim (whitespace
 * collapsed) but never allowed to grow past this bound, and request
 * headers/keys are never echoed into the message.
 */
export const MAX_AI_PROVIDER_ERROR_MESSAGE_LENGTH = 500;

const MAX_RETRY_AFTER_DELAY_MS = 60_000;
const DEFAULT_RETRY_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 750;
const RETRY_JITTER_RATIO = 0.25;
const MAX_ATTEMPT_COUNT = 5;

export interface AiProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
}

/**
 * Provider-neutral completion result. Both the Anthropic and the
 * OpenAI-compatible adapters must return exactly this shape so persistence
 * and the SSE `done` event can treat them interchangeably.
 */
export interface AiProviderCompletion {
  content: string;
  toolCalls: AiNativeToolCall[];
  /** True when the provider stopped because the output token budget was exhausted. */
  truncated: boolean;
  /** Provider-native stop/finish reason (`max_tokens`, `length`, `tool_use`, ...). */
  stopReason: string | null;
  usage: AiProviderUsage | null;
}

/**
 * Visible note appended to persisted assistant messages when the response was
 * cut off by the output token limit.
 */
export const AI_TRUNCATION_NOTE = "[Response truncated — increase AI_MAX_OUTPUT_TOKENS]";

export function appendAiTruncationNote(content: string) {
  if (!content) {
    return AI_TRUNCATION_NOTE;
  }
  return `${content}\n\n${AI_TRUNCATION_NOTE}`;
}

export function createAiProviderCompletion(input: {
  content: string;
  toolCalls: AiNativeToolCall[];
  truncated?: boolean;
  stopReason?: string | null;
  usage?: { inputTokens?: number | null; outputTokens?: number | null; cacheReadTokens?: number | null } | null;
}): AiProviderCompletion {
  return {
    content: input.content,
    toolCalls: input.toolCalls,
    truncated: input.truncated ?? false,
    stopReason: input.stopReason ?? null,
    usage: input.usage
      ? {
          inputTokens: input.usage.inputTokens ?? null,
          outputTokens: input.usage.outputTokens ?? null,
          cacheReadTokens: input.usage.cacheReadTokens ?? null,
        }
      : null,
  };
}

function settingsAsObject(settings: unknown) {
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : null;
}

function readPositiveIntegerField(settings: unknown, key: string) {
  const record = settingsAsObject(settings);
  if (!record) {
    return null;
  }
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return null;
  }
  return value;
}

const MAX_AI_MAX_OUTPUT_TOKENS = 1_000_000;

/**
 * Resolves the per-request output token budget.
 *
 * Precedence: per-provider `settings.maxOutputTokens` (when the provider
 * record carries a settings field) → `AI_MAX_OUTPUT_TOKENS` env var → 16384.
 */
export function resolveAiMaxOutputTokens(providerSettings?: unknown): number {
  const fromSettings = readPositiveIntegerField(providerSettings, "maxOutputTokens");
  if (fromSettings !== null) {
    return fromSettings;
  }

  const rawEnvValue = process.env.AI_MAX_OUTPUT_TOKENS?.trim();
  if (rawEnvValue) {
    const parsed = Number(rawEnvValue);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_AI_MAX_OUTPUT_TOKENS) {
      return parsed;
    }
  }

  return 16_384;
}

/**
 * Returns the explicitly configured sampling temperature, or null when none is
 * configured. Reasoning-model endpoints reject temperature, so adapters must
 * omit the parameter entirely unless the provider set one.
 */
export function resolveAiProviderTemperature(providerSettings?: unknown): number | null {
  const record = settingsAsObject(providerSettings);
  const value = record?.temperature;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 2) {
    return value;
  }
  return null;
}

/**
 * Error thrown when the upstream provider answers with a non-OK HTTP status
 * or terminates a stream with an error event. Carries the status (null for
 * in-stream failures) so callers can summarize failures without echoing the
 * upstream response body back to the client.
 */
export class AiProviderError extends Error {
  /** HTTP status when the error came from a response, null for in-stream failures. */
  readonly status: number | null;
  readonly code: string;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: { status?: number | null; code: string; retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AiProviderError";
    this.status = options.status ?? null;
    this.code = options.code;
    this.retryable = options.retryable;
  }
}

/**
 * @deprecated Legacy alias kept for existing `instanceof` checks; this is the
 * same class as {@link AiProviderError}. New code should use that name.
 */
export { AiProviderError as UpstreamProviderError };

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

function errorRecordString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function extractProviderErrorDetails(body: string): { message: string | null; code: string | null } {
  const trimmedBody = body.trim();
  if (!trimmedBody) {
    return { message: null, code: null };
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(trimmedBody);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== "object") {
    return { message: trimmedBody.slice(0, MAX_AI_PROVIDER_ERROR_MESSAGE_LENGTH), code: null };
  }

  const record = parsed as Record<string, unknown>;
  const errorField = record.error;
  let message: string | null = null;
  let code: string | null = null;

  if (typeof errorField === "string") {
    message = errorField;
  } else if (errorField && typeof errorField === "object") {
    const errorRecord = errorField as Record<string, unknown>;
    message = errorRecordString(errorRecord, "message");
    code = errorRecordString(errorRecord, "code") ?? errorRecordString(errorRecord, "type");
  }

  if (!message && typeof record.message === "string") {
    message = record.message;
  }
  if (!message && typeof record.detail === "string") {
    message = record.detail;
  }
  if (!code) {
    code = errorRecordString(record, "code") ?? errorRecordString(record, "type");
  }

  return {
    message: message ? message.replace(/\s+/g, " ").trim().slice(0, MAX_AI_PROVIDER_ERROR_MESSAGE_LENGTH) : null,
    code,
  };
}

/**
 * Converts a non-OK provider response into a typed `AiProviderError`, using
 * the provider's own message/code from the JSON (or plain-text) body. Request
 * headers, API keys, and anything beyond the first 8KB of the body are never
 * echoed.
 */
export async function aiProviderErrorFromResponse(response: Response): Promise<AiProviderError> {
  const status = response.status;
  let body = "";
  try {
    body = (await response.text()).slice(0, 8_192);
  } catch {
    // Body unavailable (or already consumed) — fall back to a generic message.
  }

  const { message, code } = extractProviderErrorDetails(body);
  return new AiProviderError(
    message ?? `Provider request failed with status ${status}`,
    {
      status,
      code: code ?? `http_${status}`,
      retryable: AI_PROVIDER_RETRYABLE_STATUSES.has(status),
    }
  );
}

/** Parses a `Retry-After` header (delay-seconds or HTTP-date) into milliseconds. */
export function parseAiProviderRetryAfterMs(headerValue: string | null | undefined): number | null {
  if (!headerValue) {
    return null;
  }
  const trimmed = headerValue.trim();
  if (!trimmed) {
    return null;
  }
  if (/^\d{1,6}$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1_000, MAX_RETRY_AFTER_DELAY_MS);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isNaN(parsedDate)) {
    return Math.min(Math.max(parsedDate - Date.now(), 0), MAX_RETRY_AFTER_DELAY_MS);
  }
  return null;
}

/**
 * Backoff delay for the given attempt (1-based): exponential in the attempt
 * number with proportional jitter, overridden by `Retry-After` when present.
 */
export function computeAiProviderRetryDelayMs(attempt: number, retryAfterMs: number | null, baseDelayMs: number): number {
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, MAX_RETRY_AFTER_DELAY_MS);
  }
  const exponential = Math.max(0, baseDelayMs) * 2 ** (attempt - 1);
  const jitter = Math.round(exponential * RETRY_JITTER_RATIO * Math.random());
  return Math.min(exponential + jitter, MAX_RETRY_AFTER_DELAY_MS);
}

export interface AiProviderRetryOptions {
  /** Total attempts (initial call + retries). Default 3. */
  maxAttempts?: number;
  /** Base delay for exponential backoff; injectable so tests can avoid real waits. Default 750ms. */
  baseDelayMs?: number;
  /** Injectable timer hook for tests. Defaults to a `setTimeout` promise so fake timers work. */
  sleep?: (ms: number) => Promise<void>;
}

function isAbortLikeError(error: unknown) {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
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
 * DNS-rebinding window minimal (and the same re-validation covers every hop of
 * a redirect chain, see MAX_PROVIDER_REDIRECT_HOPS below).
 */
/**
 * Maximum number of 3xx redirects `fetchAiProvider` will follow. Re-validating
 * every hop is not free (DNS + policy checks per hop), so chains are bounded.
 */
const MAX_PROVIDER_REDIRECT_HOPS = 3;

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);

/** Statuses that collapse the request into a plain GET without a body. */
const REDIRECT_METHOD_RESET_STATUS_CODES = new Set([301, 302, 303]);

/**
 * Credential-bearing headers: they are never re-sent to a different origin.
 * A redirect can otherwise be used to exfiltrate the provider API key to an
 * attacker-controlled host (307/308 preserve the method, body, and headers).
 */
const SENSITIVE_REDIRECT_HEADERS = ["authorization", "proxy-authorization", "x-api-key", "cookie"] as const;

/**
 * Follows provider redirects manually so every hop is re-validated against the
 * SSRF policy before it is requested:
 *
 * - `redirect: "manual"` (never the default `"follow"`, which would happily
 *   take a validated public URL straight to `127.0.0.1`, RFC1918 space, or a
 *   cloud metadata endpoint);
 * - `assertAiProviderBaseUrlFetchAllowed` runs on every resolved hop;
 * - at most {@link MAX_PROVIDER_REDIRECT_HOPS} redirects are followed;
 * - Authorization / x-api-key / cookie / proxy-authorization are stripped when
 *   the redirect crosses to a different origin;
 * - only 307/308 re-send the request body (and method); 301/302/303 become a
 *   plain GET, so the body can never be replayed elsewhere.
 */
export async function fetchAiProvider(url: string, init?: RequestInit): Promise<Response> {
  const validatedUrl = await assertAiProviderBaseUrlFetchAllowed(url);

  let method = (init?.method ?? "GET").toUpperCase();
  let currentUrl = validatedUrl;
  let currentOrigin = new URL(validatedUrl).origin;
  const headers = new Headers(init?.headers);
  let body = init?.body;

  for (let followedRedirects = 0; ; followedRedirects += 1) {
    if (followedRedirects > MAX_PROVIDER_REDIRECT_HOPS) {
      throw new AiProviderError(
        `Provider redirected too many times (limit ${MAX_PROVIDER_REDIRECT_HOPS} redirects)`,
        { code: "too_many_redirects", retryable: false },
      );
    }

    const response = await fetch(currentUrl, { ...init, redirect: "manual", method, headers, body });

    if (!REDIRECT_STATUS_CODES.has(response.status)) {
      return response;
    }

    const locationHeader = response.headers.get("location");
    if (!locationHeader) {
      // A 3xx without Location is a terminal response, not a redirect.
      return response;
    }

    const redirectUrl = new URL(locationHeader, currentUrl).toString();
    let validatedRedirectUrl: string;
    try {
      validatedRedirectUrl = await assertAiProviderBaseUrlFetchAllowed(redirectUrl);
    } catch (error) {
      throw new AiProviderError("Provider redirected to a disallowed target", {
        code: "redirect_disallowed",
        retryable: false,
        cause: error,
      });
    }

    if (REDIRECT_METHOD_RESET_STATUS_CODES.has(response.status)) {
      method = "GET";
      body = undefined;
    }

    const nextOrigin = new URL(validatedRedirectUrl).origin;
    if (nextOrigin !== currentOrigin) {
      for (const headerName of SENSITIVE_REDIRECT_HEADERS) {
        headers.delete(headerName);
      }
    }

    currentOrigin = nextOrigin;
    currentUrl = validatedRedirectUrl;
  }
}

export function normalizeAiProviderRequestError(error: unknown, timeoutMs: number) {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" ||
      error.name === "TimeoutError" ||
      /aborted due to timeout/i.test(error.message)
    ) {
      // Typed so downstream consumers (e.g. the provider test summary) treat
      // this fixed, Taskito-authored message as a known safe error class.
      return new AiProviderError(`AI provider request timed out after ${Math.ceil(timeoutMs / 1000)} seconds`, {
        code: "timeout",
        retryable: false,
      });
    }

    return error;
  }

  return new AiProviderError("AI provider request failed", { code: "provider_request_failed", retryable: false });
}

/**
 * `fetchAiProvider` with retry semantics for transient failures
 * (408/409/429/500/502/503/504/529 statuses and pre-response network errors).
 *
 * Retries only wrap the request dispatch, so they can never re-run once a
 * streamed byte has been consumed — streaming consumers always observe a
 * single attempt. Honours `Retry-After` and uses exponential backoff with
 * jitter otherwise; aborts and exhausted attempts surface the last
 * response/error unchanged.
 */
export async function fetchAiProviderWithRetry(
  url: string,
  init?: RequestInit,
  options?: AiProviderRetryOptions
): Promise<Response> {
  const maxAttempts = Math.min(Math.max(options?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS, 1), MAX_ATTEMPT_COUNT);
  const baseDelayMs = Math.max(0, options?.baseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
  const sleep = options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  for (let attempt = 1; ; attempt += 1) {
    let response: Response;
    try {
      response = await fetchAiProvider(url, init);
    } catch (error) {
      const typedNonRetryable = error instanceof AiProviderError && !error.retryable;
      const canRetry =
        attempt < maxAttempts &&
        init?.signal?.aborted !== true &&
        !isAbortLikeError(error) &&
        !typedNonRetryable;
      if (!canRetry) {
        throw error;
      }
      await sleep(computeAiProviderRetryDelayMs(attempt, null, baseDelayMs));
      continue;
    }

    if (!AI_PROVIDER_RETRYABLE_STATUSES.has(response.status) || attempt >= maxAttempts) {
      return response;
    }

    const retryAfterMs = parseAiProviderRetryAfterMs(response.headers.get("retry-after"));
    try {
      await response.arrayBuffer();
    } catch {
      // Draining the discarded response body is best-effort.
    }
    await sleep(computeAiProviderRetryDelayMs(attempt, retryAfterMs, baseDelayMs));
  }
}