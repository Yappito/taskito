import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";

import {
  assertOutboundRequestPinned,
  createPinnedOutboundLookup,
  OutboundUrlValidationError,
  type PinnedOutboundConnection,
} from "@/lib/ai-provider-validation";
import {
  WEBHOOK_MAX_RESPONSE_BYTES,
  WEBHOOK_TIMEOUT_MS,
  webhookDeliveryConcurrency,
  webhookDeliveryLeaseMs,
  webhookDeliveryPreflightDeadlineMs,
  webhookDeliveryQueueMaxDepth,
  webhookLeaseMarginMs,
  webhookRequestTimeoutMs,
} from "@/lib/webhook-limits";

// Kept as part of the dispatcher's public surface (moved into webhook-limits
// so the claim-lease floor can be derived from it).
export { WEBHOOK_TIMEOUT_MS };
import { decryptSecret } from "@/lib/secret-crypto";
import { isWebhookEvent, WEBHOOK_PING_EVENT } from "@/lib/webhook-events";
import { getEffectiveProjectAccess } from "@/server/authz";
import { assertTickAlive, TickDeadlineExceededError } from "@/server/services/scheduler-deadline";

import {
  computeWebhookSignature,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "./signature";

type PrismaClient = typeof import("@/lib/prisma").prisma;

/**
 * Outbound webhook dispatcher.
 *
 * Project webhooks subscribe to a set of events; every matching event fans out
 * into one `WebhookDelivery` row per enabled+subscribed webhook, and each row
 * is POSTed as JSON signed with the webhook's secret (HMAC-SHA256 over
 * `"<timestamp>.<body>"`). Delivery envelopes are built from a strict
 * whitelist of metadata fields — never comment/task bodies, emails, or
 * secrets (task rows passed by callers routinely contain all three; the
 * whitelist strips them here).
 *
 * Delivery lifecycle:
 *  - `emitWebhookEvent` creates the rows (`status: "pending"`,
 *    `nextAttemptAt: now`) and enqueues them into a bounded worker queue
 *    (`WEBHOOK_DELIVERY_CONCURRENCY` concurrent POSTs), so webhook failures
 *    never fail the originating mutation and a large fan-out cannot open one
 *    socket per webhook;
 *  - the claim is exclusive AND owned: `deliverWebhook` atomically
 *    transitions `pending -> processing` (`updateMany` where
 *    `status = pending` AND the row is due) before any I/O, stamps a random
 *    per-claim `claimToken` + lease deadline (`leaseExpiresAt`), and only the
 *    claim token owner finalizes the row — every success/failure/requeue
 *    update must present the SAME token (`updateMany` where `id AND status
 *    = processing AND claimToken = ours`), so a worker whose lease expired
 *    and was recovered by another worker can never clobber the new claim.
 *    Only the worker whose update matched (`count === 1`) proceeds, so the
 *    inline pass and the scheduler sweep can never double-deliver the same
 *    event;
 *  - the scheduler's `processDueWebhookDeliveries` first deliberately recovers
 *    expired `processing` leases back to `pending` and clears the claim token
 *    (crashed worker), then sweeps rows whose `nextAttemptAt` came due
 *    (retries + anything the inline pass missed because the process restarted);
 *  - failures ALWAYS leave the row schedulable: a non-exhausted failure hands
 *    the owned claim back to `pending` (status + backoff `nextAttemptAt`, no
 *    lease) so the sweep re-claims it; only exhausted attempts mark "failed";
 *  - before decrypt/sign/POST, the delivery re-checks that the webhook's
 *    creator STILL holds `automation_manage` + `task_read` on the project and
 *    is not disabled (fail closed) — an already-queued delivery must not keep
 *    POSTing task metadata after its creator lost read access. The check runs
 *    under a deadline (the preflight budget) so a slow/stalled authz query
 *    cannot stall the worker indefinitely; a deadline hit fails closed (no
 *    POST) via the bounded retry ladder;
 *  - the preflight (URL validation + DNS pin) runs under an explicit deadline
 *    (`webhookDeliveryPreflightDeadlineMs`) so it cannot spin forever, and the
 *    initial lease is floored at preflight budget + POST timeout;
 *  - wave-9 finding 1: the lease is RENEWED immediately BEFORE the POST,
 *    token-gated (matching `id` + `processing` + the claim token). The
 *    initial lease covers the whole claim → authz → preflight → decrypt →
 *    sign sequence, but those stages can legitimately run long (claim
 *    round-trip, DNS, queue latency), so the static floor alone can be
 *    outlasted by a still-pending POST. Renewing right before `postWebhookRequest`
 *    stamps `leaseExpiresAt = now + webhookRequestTimeoutMs() + margin`, so
 *    the lease covers EXACTLY the POST window regardless of how long the
 *    preceding stages took. If the renewal matches 0 rows the claim was
 *    already stolen (expired + recovered or redelivered) — the delivery is
 *    skipped and never POSTed after losing its claim.
 *  - target URLs are re-validated (same SSRF policy as at create time) AND
 *    the connection is PINNED to the validated address: the dispatcher
 *    resolves once, checks every A/AAAA answer against the block rules, then
 *    issues the request through a lookup override that can only return the
 *    pre-validated IP — the original hostname is preserved for TLS SNI and
 *    the Host header, and connect-time DNS can never steer the request to a
 *    private address (DNS-rebinding TOCTOU);
 *  - redirects are never followed (the transport treats a 3xx as a failure):
 *    each hop would need re-validation and could steer a signed request to a
 *    different target;
 *  - each request is capped by the SAME configured timeout the claim-lease
 *    floor is derived from (`webhookRequestTimeoutMs()`, i.e. the clamped
 *    `WEBHOOK_TIMEOUT_MS` env value — never a separate constant: a
 *    divergence would let the real POST outlive the lease and cause a
 *    duplicate delivery) and response bodies are
 *    stream-discarded after `WEBHOOK_MAX_RESPONSE_BYTES` — the delivery only
 *    needs the status code. The in-process inline queue is depth-capped;
 *    overflow falls back to the durable `pending` rows + scheduler sweep.
 */

const LOG_PREFIX = "[webhooks]";

/** Total attempts per delivery (the initial POST + up to two retries). */
export const WEBHOOK_MAX_ATTEMPTS = 3;

/** Backoff ladder by failed-attempt count: retry 1 after 1m, retry 2 after 5m (30m tail kept for clarity if the attempt cap is raised). */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;

/** Largest error string persisted on a delivery (authored by Taskito, never upstream response bodies). */
const MAX_LAST_ERROR_LENGTH = 500;

const MAX_DELIVERIES_PER_SWEEP = 25;

export function webhookAllowPrivateHosts() {
  return process.env.WEBHOOK_ALLOW_PRIVATE_HOSTS === "true";
}

export interface WebhookTaskSnapshot {
  id: string | null;
  /** Human-facing task key (`<projectKey>-<taskNumber>`), computed from project data. */
  key: string | null;
  title: string | null;
  statusId: string | null;
  assigneeId: string | null;
  priority: string;
  dueDate: string | null;
}

/** Extra per-event content appended to the envelope, next to `task`. */
export interface WebhookEventPayload {
  /**
   * Task snapshot. May be a raw Prisma task row (creator/assignee relations,
   * body, description, …) — only the whitelisted fields above are forwarded.
   */
  task?: unknown;
  commentId?: string | null;
  /** `{ field: { from, to } }` change set (already JSON-serializable values). */
  changes?: Record<string, { from: unknown; to: unknown }> | null;
}

export interface WebhookEventInput {
  projectId: string;
  event: string;
  payload?: WebhookEventPayload;
  actorId?: string | null;
  /**
   * Injectable outbound transport (used by tests); production requests go
   * through {@link defaultWebhookTransport}, which pins the connection to the
   * SSRF-validated address.
   */
  transport?: WebhookTransport;
}

/** The event envelope stored on the delivery row and POSTed verbatim. */
export type WebhookEnvelope = {
  id: string;
  event: string;
  occurredAt: string;
  project: { id: string; key: string; slug: string; name: string } | null;
  actor: { id: string; name: string | null } | null;
  task?: WebhookTaskSnapshot;
  comment?: { id: string };
  changes?: Record<string, { from: unknown; to: unknown }>;
};

function describeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function boundedError(error: unknown, fallback: string) {
  const message = describeError(error).replace(/\s+/g, " ").trim();
  return (message || fallback).slice(0, MAX_LAST_ERROR_LENGTH);
}

function toIsoString(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    return value;
  }
  return null;
}

/**
 * Whitelist-shapes a task row into the envelope's `task` snapshot. This is the
 * single choke point that keeps bodies, descriptions, emails, and every other
 * task column out of webhook payloads.
 */
export function buildWebhookTaskSnapshot(task: unknown, projectKey: string | null): WebhookTaskSnapshot | null {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    return null;
  }
  const row = task as Record<string, unknown>;
  const taskNumber = typeof row.taskNumber === "number" ? row.taskNumber : null;
  const priority = typeof row.priority === "string" ? row.priority : "none";
  return {
    id: typeof row.id === "string" ? row.id : null,
    key: projectKey && taskNumber !== null ? `${projectKey}-${taskNumber}` : null,
    title: typeof row.title === "string" ? row.title : null,
    statusId: typeof row.statusId === "string" ? row.statusId : null,
    assigneeId: typeof row.assigneeId === "string" ? row.assigneeId : null,
    priority,
    dueDate: toIsoString(row.dueDate),
  };
}

/** Whitelist-shapes `{ field: { from, to } }` change maps (Dates become ISO strings). */
function buildWebhookChanges(changes: Record<string, { from: unknown; to: unknown }> | null | undefined) {
  if (!changes || typeof changes !== "object") {
    return undefined;
  }
  const shaped: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, change] of Object.entries(changes)) {
    if (!change || typeof change !== "object") {
      continue;
    }
    shaped[field] = { from: toIsoString(change.from) ?? (change.from ?? null), to: toIsoString(change.to) ?? (change.to ?? null) };
  }
  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

/**
 * Builds the outbound body for a delivery row. The `id` (delivery id) is
 * merged in at send time because the row id only exists after the insert.
 */
function buildDeliveryBody(payload: unknown, deliveryId: string): string {
  const base = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  return JSON.stringify({ ...base, id: deliveryId });
}

interface WebhookUpdateManyResult {
  count: number;
}

export interface DeliverWebhookResult {
  status: "pending" | "processing" | "success" | "failed" | "skipped";
  responseCode?: number | null;
  error?: string;
}

export interface DeliverWebhookOptions {
  now?: Date;
  timeoutMs?: number;
  /** Injectable outbound transport (tests); defaults to the Node transport. */
  transport?: WebhookTransport;
}

/**
 * Performs (or retries) one webhook delivery: claims the row exclusively
 * (pending -> processing + lease), re-validates and pins the URL, decrypts the
 * signing secret, POSTs the signed payload, and records success or schedules
 * the next attempt. Never throws — all outcomes land in the row.
 */
export async function deliverWebhook(
  prisma: PrismaClient,
  deliveryId: string,
  options: DeliverWebhookOptions = {},
): Promise<DeliverWebhookResult> {
  const now = options.now ?? new Date();

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: {
        select: {
          id: true,
          url: true,
          encryptedSecret: true,
          isEnabled: true,
          projectId: true,
          createdByUserId: true,
        },
      },
    },
  });
  if (!delivery || !delivery.webhook) {
    return { status: "skipped", error: "Delivery or webhook no longer exists" };
  }
  if (delivery.status !== "pending") {
    return { status: "skipped", error: `Delivery is ${delivery.status}` };
  }
  if (!delivery.webhook.isEnabled) {
    return { status: "skipped", error: "Webhook is disabled" };
  }

  // Exclusive, OWNED claim: transition pending -> processing while the row is
  // still pending AND due, stamping a random per-claim owner token. Postgres
  // evaluates this as a single UPDATE, so exactly one of two concurrent
  // workers gets count === 1 and may deliver; the other must skip. During
  // processing the row is invisible to further claims (status no longer
  // pending), and every finalize/requeue update must present the SAME token —
  // a worker whose lease expired and was recovered/re-claimed by another
  // worker can no longer match its own token and cannot clobber the new
  // claim. The lease bounds the damage of a crashed worker (recovered by the
  // scheduler sweep, which mints a fresh token on the next claim).
  //
  // The lease window starts when THIS row is claimed (wave-8 finding 1b), NOT
  // at the caller's `now`: the scheduler hands ONE sweep timestamp to every
  // sequential delivery, so a lease derived from it would already be minutes
  // old (near-expired) by the time later rows reach their read → authz →
  // preflight → POST sequence. `claimedAt` is captured at the moment of the
  // claim UPDATE itself so the window always covers what follows.
  const claimToken = crypto.randomUUID();
  const claimedAt = new Date();
  const claim = (await prisma.webhookDelivery.updateMany({
    where: {
      id: delivery.id,
      status: "pending",
      nextAttemptAt: { lte: now },
    },
    data: {
      status: "processing",
      attempts: { increment: 1 },
      claimToken,
      leaseExpiresAt: new Date(claimedAt.getTime() + webhookDeliveryLeaseMs()),
    },
  })) as WebhookUpdateManyResult;
  if (claim.count === 0) {
    return { status: "skipped", error: "Delivery already claimed by another worker" };
  }
  const attempts = delivery.attempts + 1;

  // Send-time confused-deputy re-check, BEFORE decrypt/sign/POST: the
  // delivery may have been enqueued long before the creator was disabled,
  // demoted, or denied task_read — the endpoint still receives task
  // metadata, so access must hold at send time, not just at enqueue time.
  // The check is BOUNDED (wave-9 finding 1): a slow or stalled DB query
  // would otherwise have no deadline at all — runWithDeadline abandons it
  // after the preflight budget and we FAIL CLOSED (no POST) via the normal
  // bounded retry ladder; a later attempt re-checks access.
  let creatorMayDeliver: boolean;
  try {
    creatorMayDeliver = await runWithDeadline(
      webhookCreatorMayDeliver(prisma, delivery.webhook.createdByUserId, delivery.webhook.projectId),
      webhookDeliveryPreflightDeadlineMs(),
      "Webhook creator access re-check",
    );
  } catch (error) {
    if (!(error instanceof WebhookPreflightDeadlineError)) {
      throw error;
    }
    // Fail closed: mark the delivery failed for this attempt (no POST, no
    // unbounded stall) and schedule a bounded retry.
    const message = boundedError(error, "authz deadline exceeded");
    await recordFailure(prisma, delivery.id, claimToken, attempts, now, message, null);
    return { status: attempts >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending", responseCode: null, error: message };
  }
  if (!creatorMayDeliver) {
    const message = `Webhook creator no longer holds automation_manage + task_read on the project; delivery cancelled without sending`;
    await finalizeOwnedClaim(prisma, delivery.id, claimToken, {
      status: "failed" as const,
      attempts,
      responseCode: null,
      lastError: message,
      nextAttemptAt: now,
    });
    return { status: "failed", responseCode: null, error: message };
  }

  // SSRF re-validation at send time: the webhook may have been created before
  // an operator-tightened environment, or DNS may have changed since create.
  // The connection is pinned to the validated answer so the actual request
  // cannot be re-steered by a lookup at connect time. The preflight runs
  // under an explicit deadline (DNS lookups have no timeout of their own);
  // the deadline is derived from the claim lease so validation can never
  // outlive the claim.
  let target: PinnedOutboundConnection;
  try {
    target = await runWithDeadline(
      assertOutboundRequestPinned(delivery.webhook.url, {
        label: "Webhook URL",
        allowPrivateHosts: webhookAllowPrivateHosts(),
        privateHostsHint: "Set WEBHOOK_ALLOW_PRIVATE_HOSTS=true to allow webhook delivery to private, self-hosted targets",
      }),
      webhookDeliveryPreflightDeadlineMs(),
    );
  } catch (error) {
    if (!(error instanceof OutboundUrlValidationError || error instanceof WebhookPreflightDeadlineError)) {
      throw error;
    }
    await recordFailure(prisma, delivery.id, claimToken, attempts, now, error.message, null);
    return { status: attempts >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending", responseCode: null, error: error.message };
  }

  // A decryption failure used to escape the failure path, leaving the row
  // pending forever (retried every tick past WEBHOOK_MAX_ATTEMPTS) after a
  // master-key rotation. Treat it as a normal bounded failure instead.
  let secret: string;
  try {
    secret = decryptSecret(delivery.webhook.encryptedSecret);
  } catch (error) {
    const message = `Webhook secret could not be decrypted (${boundedError(error, "decryption failed")}); rotate stored secrets with npm run db:reencrypt-ai-secrets`;
    await recordFailure(prisma, delivery.id, claimToken, attempts, now, message, null);
    return {
      status: attempts >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending",
      responseCode: null,
      error: message,
    };
  }

  const body = buildDeliveryBody(delivery.payload, delivery.id);
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const signature = computeWebhookSignature(secret, timestamp, body);

  // Wave-9 finding 1 — RENEW the lease immediately BEFORE the POST, under
  // the claim token. The initial lease was stamped at claim time and floored
  // at preflight + request timeout, but the claim round-trip, the authz
  // query, decrypt/sign, and the DNS preflight all consume that window
  // BEFORE the POST starts, so the POST could still survive past
  // `leaseExpiresAt` and a recovery pass could start a second POST while the
  // first is live. Re-stamping here makes the lease cover exactly the POST
  // window regardless of how long the preceding stages took.
  const renewedAt = new Date();
  const renewal = (await prisma.webhookDelivery.updateMany({
    where: { id: delivery.id, status: "processing", claimToken },
    data: {
      leaseExpiresAt: new Date(renewedAt.getTime() + webhookRequestTimeoutMs() + webhookLeaseMarginMs()),
    },
  })) as WebhookUpdateManyResult;
  if (renewal.count === 0) {
    // Our claim was already stolen (expired + recovered, or redelivered):
    // another worker owns this delivery now. NEVER POST after losing the
    // claim — the incoming second POST would duplicate the event.
    console.warn(
      `${LOG_PREFIX} stale claim on delivery ${delivery.id}: lease renewal rejected before the POST; skipping delivery (claim lost)`
    );
    return { status: "skipped", error: "Webhook delivery claim was lost before the POST could start (lease recovered or redelivered)" };
  }

  const outcome = await postWebhookRequest(target.url, {
    body,
    event: delivery.event,
    deliveryId: delivery.id,
    signature,
    timestamp,
    timeoutMs: options.timeoutMs,
    lookup: createPinnedOutboundLookup(target),
    transport: options.transport,
  });

  if (outcome.ok && outcome.responseCode !== null) {
    // Finalize only while still the processing owner (same claim token): a
    // recovered lease (another worker's re-claim) must never be clobbered by
    // this worker's late write.
    const finalize = (await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "processing", claimToken },
      data: {
        status: "success",
        responseCode: outcome.responseCode,
        attempts: { set: attempts },
        lastError: null,
        nextAttemptAt: now,
        leaseExpiresAt: null,
      },
    })) as WebhookUpdateManyResult;
    if (finalize.count === 0) {
      console.warn(
        `${LOG_PREFIX} stale claim on delivery ${delivery.id}: success finalize rejected (lease recovered or redelivered while POST was in flight)`,
      );
    }
    return { status: "success", responseCode: outcome.responseCode };
  }

  await recordFailure(prisma, delivery.id, claimToken, attempts, now, outcome.error ?? "Webhook delivery failed", outcome.responseCode);
  return {
    status: attempts >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending",
    responseCode: outcome.responseCode,
    error: outcome.error ?? undefined,
  };
}

/**
 * Deadline error for the send-time preflight (URL validation + DNS) and the
 * bounded send-time authz re-check. Treated like any other pre-flight
 * failure: bounded retry, never an unhandled throw.
 */
export class WebhookPreflightDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookPreflightDeadlineError";
  }
}

/**
 * Races `promise` against a hard deadline so a hung DNS validation (or a
 * stalled send-time authz query) cannot hold a worker indefinitely. The
 * losing promise is NOT cancelled (Node DNS has no cancellation) — it is
 * simply abandoned.
 */
async function runWithDeadline<T>(promise: Promise<T>, deadlineMs: number, label = "Webhook URL validation (DNS)"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new WebhookPreflightDeadlineError(
          `${label} exceeded the ${Math.ceil(deadlineMs / 1000)}s deadline`,
        ),
      );
    }, deadlineMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Finalizes a claim the worker still owns: every success/failure/requeue
 * update is gated on `id` + `status: "processing"` + the claim's own token.
 * A worker whose lease expired and was recovered (or whose row was
 * redelivered) no longer matches — its update affects 0 rows and the new
 * claim is left untouched.
 */
async function finalizeOwnedClaim(
  prisma: PrismaClient,
  deliveryId: string,
  claimToken: string,
  data: {
    status: "success" | "failed" | "pending";
    attempts: number;
    responseCode: number | null;
    lastError: string | null;
    nextAttemptAt: Date;
  },
) {
  return (await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "processing", claimToken },
    data: {
      attempts: { set: data.attempts },
      status: data.status,
      ...(data.status === "pending" ? { claimToken: null } : {}),
      responseCode: data.responseCode,
      lastError: data.lastError,
      nextAttemptAt: data.nextAttemptAt,
      leaseExpiresAt: null,
    },
  })) as WebhookUpdateManyResult;
}

async function recordFailure(
  prisma: PrismaClient,
  deliveryId: string,
  claimToken: string,
  attempts: number,
  now: Date,
  errorMessage: string,
  responseCode: number | null,
) {
  const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;
  const delay = WEBHOOK_RETRY_DELAYS_MS[Math.min(attempts - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
  const nextAttemptAt = exhausted ? now : new Date(now.getTime() + delay);

  // Every failure must leave the row schedulable. Non-exhausted failures hand
  // the OWNED claim back to `pending` (with a future nextAttemptAt): the
  // pending sweep then re-claims and re-delivers. (Previously a non-exhausted
  // failure left the row `processing` with a null lease — invisible to the
  // sweep and unrecoverable by lease recovery, which permanently stranded ALL
  // webhook retries.) Only exhausted attempts stop the ladder with `failed`.
  // Both transitions are guarded by the claim token so a stale worker can
  // never reschedule another worker's re-claim.
  await finalizeOwnedClaim(prisma, deliveryId, claimToken, {
    status: exhausted ? "failed" : "pending",
    attempts,
    responseCode,
    lastError: errorMessage,
    nextAttemptAt,
  });
  return { status: exhausted ? "failed" : "pending", responseCode };
}

export interface WebhookPostInit {
  body: string;
  event: string;
  deliveryId: string;
  signature: string;
  timestamp: string;
  timeoutMs?: number;
  /** Pinned lookup override from {@link createPinnedOutboundLookup} — the connection must not re-resolve DNS. */
  lookup?: import("node:net").LookupFunction;
  transport?: WebhookTransport;
}

/** Describes one outbound request handed to a {@link WebhookTransport}. */
export interface WebhookOutboundRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Pinned `lookup` for the Node transport (undefined when no pin applies). */
  lookup?: import("node:net").LookupFunction;
}

export interface WebhookOutboundResponse {
  /** HTTP status, or null when the request failed at the transport level. */
  status: number | null;
  /** Taskito-authored error description; upstream response bodies are never reflected. */
  error: string | null;
}

/**
 * Pluggable outbound transport. Production uses {@link defaultWebhookTransport}
 * (Node http/https with the pinned lookup + capped response drain); tests
 * inject doubles here.
 */
export type WebhookTransport = (request: WebhookOutboundRequest) => Promise<WebhookOutboundResponse>;

/**
 * Production outbound transport: Node http/https with an optional pinned
 * `lookup` (SSRF pin), a hard overall timeout, no redirect handling at all
 * (3xx counts as failure), and a stream-discarded response body that is
 * destroyed once it exceeds `WEBHOOK_MAX_RESPONSE_BYTES`.
 */
export const defaultWebhookTransport: WebhookTransport = (request) => {
  return new Promise<WebhookOutboundResponse>((resolve) => {
    let settled = false;
    let timedOut = false;
    const timeout = { timer: undefined as NodeJS.Timeout | undefined };
    const finish = (result: WebhookOutboundResponse) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout.timer) {
        clearTimeout(timeout.timer);
      }
      resolve(result);
    };
    const timeoutMessage = `Webhook request timed out after ${Math.ceil(request.timeoutMs / 1000)} seconds`;

    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      finish({ status: null, error: "Webhook URL is invalid" });
      return;
    }

    let req: http.ClientRequest;
    try {
      req = (parsed.protocol === "https:" ? https : http).request(parsed, {
        method: "POST",
        headers: request.headers,
        // SSRF pin: connect straight to the validated address. The URL keeps
        // the original hostname, so the Host header and (for https) the TLS
        // SNI stay the hostname while TCP goes to the pinned address.
        lookup: request.lookup,
      });
    } catch (error) {
      finish({ status: null, error: boundedError(describeError(error), "Webhook request failed") });
      return;
    }

    timeout.timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      finish({ status: null, error: timeoutMessage });
    }, request.timeoutMs);

    req.on("error", (error) => {
      finish(
        timedOut
          ? { status: null, error: timeoutMessage }
          : { status: null, error: boundedError(describeError(error) || "Webhook request failed", "Webhook request failed") },
      );
    });
    req.end(request.body);

    req.on("response", (res: IncomingMessage) => {
      const status = res.statusCode ?? 0;
      let received = 0;
      // Stream-discard: the delivery only needs the status code. Any bytes
      // beyond the cap cause the socket to be destroyed — the body is never
      // accumulated in memory.
      res.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > WEBHOOK_MAX_RESPONSE_BYTES) {
          res.destroy();
        }
      });
      res.on("end", () => finish({ status, error: null }));
      // Fires when truncated at the cap or aborted mid-body — the status we
      // already received stands.
      res.on("close", () => finish({ status, error: null }));
      res.on("error", () => {
        // Truncation (cap reached) or an aborted body still yields the status.
        finish(timedOut ? { status: null, error: timeoutMessage } : { status, error: null });
      });
      res.resume();
    });
  });
};

interface WebhookPostResult {
  ok: boolean;

  /** HTTP status when a response arrived, null on transport/timeout errors. */
  responseCode: number | null;
  /** Taskito-authored error description; upstream response bodies are never reflected. */
  error: string | null;
}

/**
 * The single outbound HTTP hop shared by deliveries and `ping` tests:
 * POST JSON with the X-Taskito-* headers, bounded timeout, redirects are
 * never followed (a 3xx is returned instead of followed and counts as a
 * failure), response bodies stream-discarded and never surfaced.
 */
export async function postWebhookRequest(url: string, init: WebhookPostInit): Promise<WebhookPostResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "Taskito-Webhook/1.0",
    [WEBHOOK_EVENT_HEADER.toLowerCase()]: init.event,
    [WEBHOOK_DELIVERY_HEADER.toLowerCase()]: init.deliveryId,
    [WEBHOOK_TIMESTAMP_HEADER.toLowerCase()]: init.timestamp,
    [WEBHOOK_SIGNATURE_HEADER.toLowerCase()]: `sha256=${init.signature}`,
  };

  try {
    const outcome = await (init.transport ?? defaultWebhookTransport)({
      url,
      headers,
      body: init.body,
      // Single source of truth (wave-8 finding 1a): the default here MUST be
      // the same clamped env value the claim-lease floor is derived from
      // (`webhookRequestTimeoutMs()`), not the frozen `WEBHOOK_TIMEOUT_MS`
      // constant — otherwise small WEBHOOK_TIMEOUT_MS environments rent a
      // lease floored off the env value while the real POST runs up to the
      // 10s constant, i.e. the lease expires while the POST is still live.
      timeoutMs: init.timeoutMs ?? webhookRequestTimeoutMs(),
      lookup: init.lookup,
    });

    if (outcome.status !== null && outcome.status >= 200 && outcome.status < 300) {
      return { ok: true, responseCode: outcome.status, error: null };
    }
    if (outcome.status !== null) {
      return { ok: false, responseCode: outcome.status, error: `Webhook responded with HTTP status ${outcome.status}` };
    }
    return { ok: false, responseCode: null, error: boundedError(outcome.error ?? "Webhook request failed", "Webhook request failed") };
  } catch (error) {
    return { ok: false, responseCode: null, error: boundedError(describeError(error) || "Webhook request failed", "Webhook request failed") };
  }
}

// ---------------------------------------------------------------------------
// Bounded delivery queue
// ---------------------------------------------------------------------------

interface QueuedDelivery {
  prisma: PrismaClient;
  deliveryId: string;
  transport?: WebhookTransport;
}

const outboundDeliveryQueue: QueuedDelivery[] = [];
let activeDeliveryPosts = 0;

function pumpWebhookDeliveryQueue() {
  const limit = webhookDeliveryConcurrency();
  while (activeDeliveryPosts < limit && outboundDeliveryQueue.length > 0) {
    const next = outboundDeliveryQueue.shift()!;
    activeDeliveryPosts += 1;
    void deliverWebhook(next.prisma, next.deliveryId, { transport: next.transport })
      .catch(() => {
        // deliverWebhook is contractually non-throwing; belt and braces.
      })
      .finally(() => {
        activeDeliveryPosts -= 1;
        pumpWebhookDeliveryQueue();
      });
  }
}

/**
 * Fire-and-forget enqueue: the bounded worker queue delivers concurrently.
 *
 * Backpressure policy: the in-process queue is depth-capped
 * (`webhookDeliveryQueueMaxDepth`). When the queue is full the inline attempt
 * is dropped — the durable `pending` delivery row remains (due immediately),
 * so the scheduler sweep re-claims and delivers it on the next tick. This
 * bounds worker memory instead of growing an unbounded array.
 */
function enqueueWebhookDelivery(prisma: PrismaClient, deliveryId: string, transport?: WebhookTransport): boolean {
  if (outboundDeliveryQueue.length >= webhookDeliveryQueueMaxDepth()) {
    console.warn(
      `${LOG_PREFIX} outbound delivery queue is full (depth >= ${webhookDeliveryQueueMaxDepth()}); leaving delivery ${deliveryId} pending for the scheduler sweep instead of enqueueing`,
    );
    return false;
  }
  outboundDeliveryQueue.push({ prisma, deliveryId, transport });
  pumpWebhookDeliveryQueue();
  return true;
}

/** Returns the queue depth + in-flight count (exposed for tests/monitoring). */
export function outboundDeliveryQueueState() {
  return { queued: outboundDeliveryQueue.length, active: activeDeliveryPosts };
}

/**
 * Re-checks that the webhook's creator still holds BOTH `automation_manage`
 * AND `task_read` on the project. Webhook endpoints receive task metadata, so
 * a principal that registered one must not keep it flowing after losing read
 * access (confused-deputy exfiltration). Fails closed on lookup errors.
 */
export async function webhookCreatorMayDeliver(
  prisma: PrismaClient,
  creatorId: string,
  projectId: string,
): Promise<boolean> {
  try {
    const access = await getEffectiveProjectAccess(prisma, creatorId, projectId);
    return access.permissions.has("automation_manage") && access.permissions.has("task_read");
  } catch {
    return false;
  }
}

/**
 * Fans one event out to every enabled+subscribed webhook of the project:
 * creates a `WebhookDelivery` row per webhook (status `pending`, due now) and
 * hands each one to the bounded delivery queue fire-and-forget. Callers invoke
 * it with `void emitWebhookEvent(...).catch(() => {})` so it can never fail a
 * mutation; slice/part failures inside only affect the fan-out itself.
 *
 * Webhooks whose creator no longer holds `automation_manage` + `task_read`
 * are skipped (the endpoint could otherwise keep receiving task metadata
 * after the principal lost read access).
 */
export async function emitWebhookEvent(
  prisma: PrismaClient,
  input: WebhookEventInput,
): Promise<{ delivered: number }> {
  if (!input.projectId || !isWebhookEvent(input.event)) {
    return { delivered: 0 };
  }

  const [project, webhooks] = await Promise.all([
    prisma.project.findUnique({
      where: { id: input.projectId },
      select: { id: true, key: true, slug: true, name: true },
    }),
    prisma.webhook.findMany({
      where: {
        projectId: input.projectId,
        isEnabled: true,
        events: { has: input.event },
      },
      select: { id: true, createdByUserId: true },
    }),
  ]);

  if (!project || webhooks.length === 0) {
    return { delivered: 0 };
  }

  // Confused-deputy guard: resolve creator permissions once per distinct
  // creator for this fan-out.
  const creatorAllowed = new Map<string, boolean>();
  const deliverableWebhooks: Array<{ id: string; createdByUserId: string }> = [];
  for (const webhook of webhooks) {
    let allowed = creatorAllowed.get(webhook.createdByUserId);
    if (allowed === undefined) {
      allowed = await webhookCreatorMayDeliver(prisma, webhook.createdByUserId, input.projectId);
      creatorAllowed.set(webhook.createdByUserId, allowed);
    }
    if (allowed) {
      deliverableWebhooks.push(webhook);
    } else {
      console.warn(
        `${LOG_PREFIX} skipping webhook ${webhook.id} for event ${input.event}: creator ${webhook.createdByUserId} no longer holds automation_manage + task_read on project ${input.projectId}`,
      );
    }
  }

  const actor = input.actorId
    ? await prisma.user.findUnique({ where: { id: input.actorId }, select: { id: true, name: true } })
    : null;

  const occurredAt = new Date();
  const taskSnapshot = buildWebhookTaskSnapshot(input.payload?.task, project.key);
  const changes = buildWebhookChanges(input.payload?.changes);
  const commentId = typeof input.payload?.commentId === "string" ? input.payload.commentId : null;

  const envelopeBase = {
    event: input.event,
    occurredAt: occurredAt.toISOString(),
    project,
    actor: actor ? { id: actor.id, name: actor.name } : null,
    ...(taskSnapshot ? { task: taskSnapshot } : {}),
    ...(commentId ? { comment: { id: commentId } } : {}),
    ...(changes ? { changes } : {}),
  };

  for (const webhook of deliverableWebhooks) {
    const created = (await prisma.webhookDelivery.create({
      data: {
        webhookId: webhook.id,
        event: input.event,
        // Inserted first, then stamped with the delivery id inside the
        // payload so the stored envelope matches the outbound body exactly.
        payload: envelopeBase as unknown as import("@prisma/client").Prisma.InputJsonValue,
        status: "pending",
        attempts: 0,
        nextAttemptAt: occurredAt,
      },
    })) as { id: string };

    await prisma.webhookDelivery.update({
      where: { id: created.id },
      data: { payload: { ...envelopeBase, id: created.id } as unknown as import("@prisma/client").Prisma.InputJsonValue },
    });

    // Fire-and-forget: enqueue the POST (bounded concurrency + depth); the
    // scheduler sweep is the safety net for anything left pending (restart,
    // failure, or an overflowed inline queue).
    enqueueWebhookDelivery(prisma, created.id, input.transport);
  }

  return { delivered: deliverableWebhooks.length };
}

/**
 * Loads the (whitelisted) task snapshot itself and delegates to
 * {@link emitWebhookEvent}. Convenience wrapper for hook sites (comments) that
 * hold a bare task projection instead of a full task row.
 */
export async function emitTaskWebhookEvent(
  prisma: PrismaClient,
  input: {
    projectId: string;
    event: string;
    taskId: string;
    actorId?: string | null;
    changes?: Record<string, { from: unknown; to: unknown }>;
    commentId?: string | null;
    transport?: WebhookTransport;
  },
): Promise<{ delivered: number }> {
  const task = await prisma.task.findUnique({
    where: { id: input.taskId },
    select: {
      id: true,
      taskNumber: true,
      title: true,
      statusId: true,
      assigneeId: true,
      priority: true,
      dueDate: true,
    },
  });
  if (!task) {
    return { delivered: 0 };
  }
  return emitWebhookEvent(prisma, {
    projectId: input.projectId,
    event: input.event,
    actorId: input.actorId,
    payload: { task, changes: input.changes, commentId: input.commentId },
    transport: input.transport,
  });
}

/**
 * Deliberately recovers deliveries whose `processing` lease has expired (the
 * claiming worker crashed mid-POST): they are handed back to `pending` so the
 * normal sweep re-claims them. Recovery also clears the claim token, which
 * permanently revokes the old worker's ownership: its late finalize/requeue
 * update (gated on the now-stale token) can no longer match — the next claim
 * mints a fresh token. Runs under the same scheduler entry point as the sweep
 * so recovery can never be forgotten.
 */
export async function recoverExpiredWebhookDeliveryLeases(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const result = (await prisma.webhookDelivery.updateMany({
    where: {
      status: "processing",
      leaseExpiresAt: { lte: now },
    },
    data: {
      status: "pending",
      nextAttemptAt: now,
      leaseExpiresAt: null,
      claimToken: null,
    },
  })) as WebhookUpdateManyResult;
  if (result.count > 0) {
    console.warn(`${LOG_PREFIX} recovered ${result.count} expired processing webhook lease(s) back to pending`);
  }
  return result.count;
}

/**
 * Scheduler-facing sweep: first recovers expired `processing` leases, then
 * delivers every still-`pending` delivery whose `nextAttemptAt` has come due.
 * Each delivery is isolated (failures are logged, never abort the sweep) and
 * claim-guarded inside `deliverWebhook`.
 *
 * M9: when called from the scheduler, `options.signal` carries the tick
 * deadline — it is checked between every unit (lease recovery, page fetch,
 * per delivery) and unwinds the sweep via {@link TickDeadlineExceededError}
 * so the tick stops promptly; already-started deliveries are lease-guarded
 * and a crashed sweep recovers them via the lease expiry on a later tick.
 */
export async function processDueWebhookDeliveries(
  prisma: PrismaClient,
  now: Date = new Date(),
  options: { limit?: number; transport?: WebhookTransport; signal?: AbortSignal } = {},
): Promise<{ processed: number; succeeded: number }> {
  assertTickAlive(options.signal);
  await recoverExpiredWebhookDeliveryLeases(prisma, now);
  assertTickAlive(options.signal);

  const due = (await prisma.webhookDelivery.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: now },
      webhook: { isEnabled: true },
    },
    orderBy: { nextAttemptAt: "asc" },
    take: Math.max(1, Math.min(options.limit ?? MAX_DELIVERIES_PER_SWEEP, MAX_DELIVERIES_PER_SWEEP)),
    select: { id: true },
  })) as Array<{ id: string }>;

  let succeeded = 0;
  for (const delivery of due) {
    // M9: stop promptly at the tick deadline instead of walking the whole
    // page; un-started deliveries remain pending for the next tick.
    assertTickAlive(options.signal);
    try {
      const result = await deliverWebhook(prisma, delivery.id, { now, transport: options.transport });
      if (result.status === "success") {
        succeeded += 1;
      }
    } catch (error) {
      if (error instanceof TickDeadlineExceededError) {
        // Propagate so the scheduler tick stops cleanly at its deadline.
        throw error;
      }
      // deliverWebhook is contractually non-throwing; keep the sweep alive.
      console.error(`${LOG_PREFIX} deliverWebhook crashed for delivery ${delivery.id}: ${boundedError(error, "unknown error")}`);
    }
  }

  return { processed: due.length, succeeded };
}

export interface SendWebhookPingResult {
  status: "success" | "failed";
  responseCode: number | null;
  error: string | null;
}

/**
 * Synchronous `ping` used by the router's `testDelivery` procedure. Sends one
 * signed webhook with the `ping` event and reports `{ status, responseCode,
 * error }` — bounded error text, no upstream body reflection, SSRF-pinned
 * connection. Never persists a delivery row.
 */
export async function sendWebhookPing(
  prisma: PrismaClient,
  input: {
    webhookId: string;
    url: string;
    encryptedSecret: string;
    projectId: string;
    now?: Date;
    timeoutMs?: number;
    transport?: WebhookTransport;
  },
): Promise<SendWebhookPingResult> {
  const now = input.now ?? new Date();

  let target: PinnedOutboundConnection;
  try {
    target = await assertOutboundRequestPinned(input.url, {
      label: "Webhook URL",
      allowPrivateHosts: webhookAllowPrivateHosts(),
      privateHostsHint: "Set WEBHOOK_ALLOW_PRIVATE_HOSTS=true to allow webhook delivery to private, self-hosted targets",
    });
  } catch (error) {
    if (error instanceof OutboundUrlValidationError) {
      return { status: "failed", responseCode: null, error: error.message };
    }
    throw error;
  }

  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { id: true, key: true, slug: true, name: true },
  });

  const deliveryId = `ping-${crypto.randomUUID()}`;
  const body = JSON.stringify({
    id: deliveryId,
    event: WEBHOOK_PING_EVENT,
    occurredAt: now.toISOString(),
    project: project ?? null,
    actor: null,
  });

  const secret = decryptSecret(input.encryptedSecret);
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const signature = computeWebhookSignature(secret, timestamp, body);

  const result = await postWebhookRequest(target.url, {
    body,
    event: WEBHOOK_PING_EVENT,
    deliveryId,
    timestamp,
    signature,
    timeoutMs: input.timeoutMs,
    lookup: createPinnedOutboundLookup(target),
    transport: input.transport,
  });

  return {
    status: result.ok ? "success" : "failed",
    responseCode: result.responseCode,
    error: result.error,
  };
}

// Re-export for callers that need the pinned-connection type alongside the
// dispatcher API.
export type { PinnedOutboundConnection };