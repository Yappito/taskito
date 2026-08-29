/**
 * Resource caps for the outbound webhook subsystem. All knobs are env-tunable
 * with safe defaults; invalid values fail closed to the default.
 */

/** Cap on webhooks registered per project (enforced at create time, finding: unbounded fan-out). */
export const DEFAULT_WEBHOOK_MAX_WEBHOOKS_PER_PROJECT = 20;

/** Cap on concurrent outbound webhook POSTs across the process (worker/queue width). */
export const DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY = 5;

/**
 * How long a delivery row may stay `processing` (the exclusive claim lease)
 * before a deliberately scheduled recovery pass hands it back to `pending`.
 */
export const DEFAULT_WEBHOOK_DELIVERY_LEASE_MS = 300_000;

/**
 * Largest upstream response body the dispatcher is willing to drain. Webhook
 * deliveries only need the HTTP status; any bytes beyond this cap are
 * discarded mid-stream so a hostile receiver cannot make Taskito buffer
 * gigabytes.
 */
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    return fallback;
  }
  return parsed;
}

/** Per-project webhook count cap (`WEBHOOK_MAX_WEBHOOKS_PER_PROJECT`, clamped to 1-100). */
export function maxWebhooksPerProject(): number {
  return envInt("WEBHOOK_MAX_WEBHOOKS_PER_PROJECT", DEFAULT_WEBHOOK_MAX_WEBHOOKS_PER_PROJECT, 1, 100);
}

/** Outbound delivery concurrency (`WEBHOOK_DELIVERY_CONCURRENCY`, clamped to 1-50). */
export function webhookDeliveryConcurrency(): number {
  return envInt("WEBHOOK_DELIVERY_CONCURRENCY", DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY, 1, 50);
}

/** Claim-lease window for `processing` deliveries (`WEBHOOK_DELIVERY_LEASE_MS`, clamped to 1s-1h). */
export function webhookDeliveryLeaseMs(): number {
  return envInt("WEBHOOK_DELIVERY_LEASE_MS", DEFAULT_WEBHOOK_DELIVERY_LEASE_MS, 1_000, 3_600_000);
}