/**
 * Outbound webhook events (project-scoped, HMAC-signed, retried).
 *
 * These are the ONLY event names a webhook may subscribe to, and the only
 * events `emitWebhookEvent` will ever fan out. Payloads are deliberately
 * minimal metadata — never comment bodies, task bodies, emails, or secrets
 * (see the whitelist in `src/server/services/webhooks/dispatcher.ts`).
 */

export const WEBHOOK_EVENTS = [
  "task.created",
  "task.updated",
  "task.status_changed",
  "task.assigned",
  "task.archived",
  "task.deleted",
  "comment.created",
  "comment.updated",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Synchronous connectivity/verification event sent by the `testDelivery` router procedure. */
export const WEBHOOK_PING_EVENT = "ping";

const WEBHOOK_EVENT_SET: ReadonlySet<string> = new Set<string>(WEBHOOK_EVENTS);

/** True when `value` is one of the subscribable webhook events. */
export function isWebhookEvent(value: string): value is WebhookEvent {
  return WEBHOOK_EVENT_SET.has(value);
}

/**
 * Narrows + dedupes a list of candidate events, preserving order.
 * Returns null when any entry is not a known event so callers can reject the
 * whole input instead of silently dropping subscriptions.
 */
export function normalizeWebhookEvents(events: readonly string[]): WebhookEvent[] | null {
  const unique: WebhookEvent[] = [];
  for (const event of events) {
    if (!isWebhookEvent(event)) {
      return null;
    }
    if (!unique.includes(event)) {
      unique.push(event);
    }
  }
  return unique;
}