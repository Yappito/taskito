import { vi } from "vitest";

import type { ResolvedAiProvider } from "@/server/services/ai/provider-registry";

/**
 * Test harness for AI provider adapters: an installable fake `fetch` that
 * records every request (url, lower-cased headers, JSON-parsed body) for
 * request-shape assertions, plus `Response` builders for SSE and JSON
 * payloads. Host allowlisting and other provider env handling stay under the
 * caller's control via {@link stubFakeProviderEnv}.
 */

/** Numeric literal host so DNS resolution succeeds offline. */
export const FAKE_PROVIDER_BASE_URL = "http://127.0.0.1:8787/v1";

export type FakeProviderAdapter = "anthropic" | "openai_compatible";

export interface FakeProviderOverrides {
  model?: string;
  settings?: Record<string, unknown>;
  defaultHeaders?: Record<string, string>;
}

export function makeFakeProvider(adapter: FakeProviderAdapter, overrides: FakeProviderOverrides = {}): ResolvedAiProvider {
  return {
    id: "fake-provider-1",
    adapter,
    baseUrl: FAKE_PROVIDER_BASE_URL,
    model: overrides.model ?? (adapter === "anthropic" ? "claude-fake-3" : "gpt-fake"),
    secret: "sk-fake-secret",
    defaultHeaders: overrides.defaultHeaders ?? {},
    settings: overrides.settings ?? {},
  };
}

/**
 * Builds minimal `AiMessage`-compatible objects for adapter calls (adapters
 * only read `role`, `content`, and `toolCallId`).
 */
export function makeFakeAiMessages(...items: Array<{ role: "system" | "user" | "assistant"; content: string }>) {
  return items.map((item, index) => ({
    id: `msg-${index}`,
    conversationId: "conv-1",
    role: item.role,
    content: item.content,
    toolName: null,
    toolPayload: null,
    toolCalls: null,
    toolCallId: null,
    usage: null,
    isStreaming: false,
    createdAt: new Date(0),
  }));
}

export interface RecordedAiProviderRequest {
  url: string;
  init: RequestInit | undefined;
  /** Lower-cased header map built from `init.headers`. */
  headers: Record<string, string>;
  /** JSON-parsed request body when the raw body was valid JSON, else the raw string. */
  body: unknown;
  rawBody: string | undefined;
}

export type FakeFetchHandler = (url: string, init: RequestInit | undefined, requestIndex: number) => Response | Promise<Response>;

/**
 * Installs a global `fetch` double via `vi.stubGlobal`. Responses can be given
 * as ready-made `Response` objects or handler functions, either as a single
 * handler (used for every request) or as an ordered list (one entry per
 * request; an exhausted list fails the request loudly).
 */
export function installFakeFetch(handlers: FakeFetchHandler | Array<Response | FakeFetchHandler>) {
  const queue = Array.isArray(handlers) ? [...handlers] : null;
  const singleHandler = Array.isArray(handlers) ? null : handlers;
  const requests: RecordedAiProviderRequest[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rawHeaders = init?.headers;
    const headers: Record<string, string> = {};
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (Array.isArray(rawHeaders)) {
      for (const [key, value] of rawHeaders) {
        headers[String(key).toLowerCase()] = String(value);
      }
    } else if (rawHeaders && typeof rawHeaders === "object") {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, unknown>)) {
        headers[key.toLowerCase()] = String(value);
      }
    }

    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    let body: unknown = rawBody;
    if (typeof rawBody === "string") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        // Keep the raw string when the body is not JSON.
      }
    }

    const request: RecordedAiProviderRequest = { url, init, headers, body, rawBody };
    requests.push(request);

    const index = requests.length - 1;
    const chosen = queue ? queue[index] : singleHandler;
    if (!chosen) {
      throw new Error(`Unexpected fake fetch call #${index + 1} to ${url}`);
    }
    if (typeof chosen === "function") {
      return chosen(url, init, index);
    }
    return chosen;
  });

  vi.stubGlobal("fetch", fetchMock);

  return {
    requests,
    fetchMock,
    restore() {
      vi.unstubAllGlobals();
    },
  };
}

/** Builds a streaming SSE `Response` emitting one `data:` event per line. */
export function sseResponse(lines: string[], init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      ...(init.headers ?? {}),
    },
  });
}

/** Builds a JSON `Response` with optional extra headers (e.g. Retry-After). */
export function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

const FAKE_PROVIDER_ENV_KEYS = [
  "AI_PROVIDER_HOST_ALLOWLIST",
  "AI_PROVIDER_ALLOW_PRIVATE_HOSTS",
  "AI_MAX_OUTPUT_TOKENS",
  "AI_PROVIDER_REQUEST_TIMEOUT_MS",
] as const;

/**
 * Allows the numeric-literal fake provider host through the SSRF checks
 * (allowlisted literal IP with an explicit `host:port` entry: no DNS loop, no
 * private-address rejection) and clears the other AI provider env vars unless
 * clears the other AI provider env vars unless a value is supplied.
 * Returns a cleanup that restores the previous environment.
 */
export function stubFakeProviderEnv(overrides: Partial<Record<(typeof FAKE_PROVIDER_ENV_KEYS)[number], string>> = {}) {
  const saved = new Map<string, string | undefined>();
  for (const key of FAKE_PROVIDER_ENV_KEYS) {
    saved.set(key, process.env[key]);
  }

  vi.stubEnv("AI_PROVIDER_HOST_ALLOWLIST", overrides.AI_PROVIDER_HOST_ALLOWLIST ?? "127.0.0.1:8787");
  for (const key of FAKE_PROVIDER_ENV_KEYS) {
    if (key === "AI_PROVIDER_HOST_ALLOWLIST") continue;
    const override = overrides[key];
    if (override === undefined) {
      if (process.env[key] !== undefined) {
        vi.stubEnv(key, "");
      }
    } else {
      vi.stubEnv(key, override);
    }
  }

  return () => {
    vi.unstubAllEnvs();
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}