const DEFAULT_AI_PROVIDER_REQUEST_TIMEOUT_MS = 90_000;

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
