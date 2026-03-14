interface RateLimitOptions {
  maxAttempts: number;
  windowMs: number;
}

interface RateLimitEntry {
  attempts: number;
  resetAt: number;
}

interface RateLimitStore {
  entries: Map<string, RateLimitEntry>;
}

/** Result of a rate-limit evaluation. */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

const stores = new Map<string, RateLimitStore>();

function getStore(bucket: string): RateLimitStore {
  const existing = stores.get(bucket);
  if (existing) {
    return existing;
  }

  const created: RateLimitStore = {
    entries: new Map<string, RateLimitEntry>(),
  };
  stores.set(bucket, created);
  return created;
}

/** Records an attempt in the given bucket and returns whether the caller is still allowed. */
export function consumeRateLimit(
  bucket: string,
  key: string,
  options: RateLimitOptions
): RateLimitResult {
  const now = Date.now();
  const store = getStore(bucket);
  const current = store.entries.get(key);

  if (!current || current.resetAt <= now) {
    const resetAt = now + options.windowMs;
    store.entries.set(key, { attempts: 1, resetAt });
    return {
      allowed: true,
      remaining: Math.max(options.maxAttempts - 1, 0),
      resetAt,
    };
  }

  current.attempts += 1;

  if (current.attempts > options.maxAttempts) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: current.resetAt,
    };
  }

  return {
    allowed: true,
    remaining: Math.max(options.maxAttempts - current.attempts, 0),
    resetAt: current.resetAt,
  };
}

/** Clears any accumulated attempts for the given bucket and key. */
export function resetRateLimit(bucket: string, key: string): void {
  const store = stores.get(bucket);
  store?.entries.delete(key);
}