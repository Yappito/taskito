/**
 * Resource caps for the outbound webhook subsystem. All knobs are env-tunable
 * with safe defaults; invalid values fail closed to the default.
 */

/** Cap on webhooks registered per project (enforced at create time, finding: unbounded fan-out). */
export const DEFAULT_WEBHOOK_MAX_WEBHOOKS_PER_PROJECT = 20;

/** Cap on concurrent outbound webhook POSTs across the process (worker/queue width). */
export const DEFAULT_WEBHOOK_DELIVERY_CONCURRENCY = 5;

/** How long a delivery row may stay `processing` by default (the exclusive claim lease). */
export const DEFAULT_WEBHOOK_DELIVERY_LEASE_MS = 300_000;

/**
 * Outbound POST timeout: one bounded request attempt
 * (`WEBHOOK_TIMEOUT_MS`, clamped to 1s-120s). Lives here (not in the
 * dispatcher) so the claim-lease floor can be derived from it without a
 * circular import.
 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

/**
 * Wall-time budget for send-time URL revalidation + DNS pinning (the
 * "preflight" before the POST). DNS answers can hang; the deadline keeps
 * preflight strictly bounded so it can never outlive the claim lease.
 */
export const DEFAULT_WEBHOOK_PREFLIGHT_BUDGET_MS = 15_000;

/**
 * Fixed buffer added on top of the outbound POST timeout when the dispatcher
 * RENEWS the claim lease immediately before the POST (wave-9 finding 1). The
 * renewal stamps `leaseExpiresAt = now + webhookRequestTimeoutMs() + margin`,
 * so under normal clock/latency conditions the lease covers the whole POST
 * window plus this slack (the slack absorbs the DB update round-trip of the
 * finalize write that follows the response).
 */
export const DEFAULT_WEBHOOK_LEASE_MARGIN_MS = 5_000;

/**
 * SANE MINIMUM for the renewed-lease margin (wave-10 finding 1): the margin
 * has to cover the lease-stamp (`updateMany`) round-trip being observed by a
 * RECOVERY sweep on another replica, plus the start of the POST. A margin of
 * 0 makes the renewed lease expire at the exact POST-timeout boundary — a
 * config footgun that lets a few milliseconds of clock/latency jitter defeat
 * the exclusive claim. A configured value below this floor is RAISED to the
 * floor (with a logged warning), never silently kept.
 */
export const MIN_WEBHOOK_LEASE_MARGIN_MS = 2_000;

/** Hard cap for the lease margin (a margin beyond one minute buys nothing). */
export const MAX_WEBHOOK_LEASE_MARGIN_MS = 60_000;

/**
 * Depth cap for the in-process outbound delivery queue. When the queue is
 * full, new deliveries are NOT enqueued inline — their durable `pending`
 * rows are still picked up by the scheduler sweep, so nothing is lost; only
 * the immediate in-process attempt is dropped (explicit backpressure instead
 * of unbounded memory growth).
 *
 * Default is 100 so the code agrees with the `.env.example` documentation.
 */
export const DEFAULT_WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH = 100;

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

/** Outbound POST timeout (`WEBHOOK_TIMEOUT_MS`, clamped to 1s-120s). */
export function webhookRequestTimeoutMs(): number {
  return envInt("WEBHOOK_TIMEOUT_MS", DEFAULT_WEBHOOK_TIMEOUT_MS, 1_000, 120_000);
}

/** DNS/URL-validation budget for one send-time preflight (`WEBHOOK_PREFLIGHT_BUDGET_MS`, clamped to 1s-60s). */
export function webhookPreflightBudgetMs(): number {
  return envInt("WEBHOOK_PREFLIGHT_BUDGET_MS", DEFAULT_WEBHOOK_PREFLIGHT_BUDGET_MS, 1_000, 60_000);
}

/** Depth cap for the in-process outbound delivery queue (`WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH`, clamped to 1-100000). */
export function webhookDeliveryQueueMaxDepth(): number {
  return envInt("WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH", DEFAULT_WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH, 1, 100_000);
}

/**
 * Buffer over the POST timeout applied when renewing the claim lease right
 * before the POST (`WEBHOOK_LEASE_MARGIN_MS`, default 5s, clamped to the sane
 * 2s-60s window).
 *
 * Wave-10 finding 1: unlike the other knobs (which fail closed to the default
 * on out-of-range input), a too-SMALL margin is the footgun here — it is
 * RAISED to the minimum with a logged warning so the renewed lease reliably
 * covers the finalize DB round-trip plus the POST start. Unparseable values
 * still fail closed to the default.
 */
export function webhookLeaseMarginMs(): number {
  const raw = process.env.WEBHOOK_LEASE_MARGIN_MS?.trim();
  if (!raw) {
    return DEFAULT_WEBHOOK_LEASE_MARGIN_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    console.warn(
      `[webhook] invalid WEBHOOK_LEASE_MARGIN_MS "${raw}", using the default ${DEFAULT_WEBHOOK_LEASE_MARGIN_MS}ms`,
    );
    return DEFAULT_WEBHOOK_LEASE_MARGIN_MS;
  }
  if (parsed < MIN_WEBHOOK_LEASE_MARGIN_MS) {
    console.warn(
      `[webhook] WEBHOOK_LEASE_MARGIN_MS (${parsed}ms) is below the ${MIN_WEBHOOK_LEASE_MARGIN_MS}ms minimum; raising it so the renewed lease reliably covers the finalize DB round-trip plus the start of the POST`,
    );
    return MIN_WEBHOOK_LEASE_MARGIN_MS;
  }
  if (parsed > MAX_WEBHOOK_LEASE_MARGIN_MS) {
    console.warn(
      `[webhook] WEBHOOK_LEASE_MARGIN_MS (${parsed}ms) exceeds the ${MAX_WEBHOOK_LEASE_MARGIN_MS}ms cap; clamping it to ${MAX_WEBHOOK_LEASE_MARGIN_MS}ms`,
    );
    return MAX_WEBHOOK_LEASE_MARGIN_MS;
  }
  return parsed;
}

/** Outbound timeout constant moved next to the derived lease floor (see dispatcher re-export). */
export const WEBHOOK_TIMEOUT_MS = DEFAULT_WEBHOOK_TIMEOUT_MS;

/**
 * Hard floor for the claim lease: it must outlive the worst case of one send
 * cycle — send-time URL validation + DNS (preflight budget) plus one full
 * bounded POST (`WEBHOOK_TIMEOUT_MS`). A lease below this could expire while
 * the claiming worker is still mid-request, letting another worker re-claim
 * a delivery that is still in flight.
 *
 * This floor is only the INITIAL lease stamped at claim time — the
 * authoritative guarantee is the token-gated lease RENEWAL the dispatcher
 * performs immediately before the POST (wave-9 finding 1), which re-stamps
 * `leaseExpiresAt` from the POST's own start instant so the claim/authz/
 * preflight stages can never consume the window the POST needs.
 */
export function webhookDeliveryLeaseFloorMs(): number {
  return webhookPreflightBudgetMs() + webhookRequestTimeoutMs();
}

/**
 * Claim-lease window for `processing` deliveries (`WEBHOOK_DELIVERY_LEASE_MS`,
 * clamped to 1s-1h) — never below the preflight + request-time floor above,
 * regardless of (too small) configuration.
 */
export function webhookDeliveryLeaseMs(): number {
  const configured = envInt("WEBHOOK_DELIVERY_LEASE_MS", DEFAULT_WEBHOOK_DELIVERY_LEASE_MS, 1_000, 3_600_000);
  return Math.max(configured, webhookDeliveryLeaseFloorMs());
}

/**
 * Wall-time budget for the send-time preflight (URL validation + DNS pinning)
 * AND for the send-time creator-access re-check inside a single delivery
 * attempt: both are bounded races so a hung DNS lookup or a stalled authz
 * query can never spin a worker indefinitely. Capped so that preflight + one
 * POST fit inside the initial claim lease. (`WEBHOOK_PREFLIGHT_BUDGET_MS`.)
 */
export function webhookDeliveryPreflightDeadlineMs(): number {
  return Math.max(1_000, Math.min(webhookPreflightBudgetMs(), webhookDeliveryLeaseMs() - webhookRequestTimeoutMs()));
}