import crypto from "node:crypto";

import {
  assertOutboundUrlAllowed,
  OutboundUrlValidationError,
} from "@/lib/ai-provider-validation";
import { decryptSecret } from "@/lib/secret-crypto";
import { isWebhookEvent, WEBHOOK_PING_EVENT } from "@/lib/webhook-events";

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
 *    `nextAttemptAt: now`) and hands each one to `deliverWebhook`
 *    fire-and-forget, so webhook failures never fail the originating mutation;
 *  - the scheduler's `processDueWebhookDeliveries` sweeps rows whose
 *    `nextAttemptAt` came due (retries + anything the inline pass missed
 *    because the process restarted);
 *  - failures are retried on a 1m / 5m / 30m backoff ladder, capped at
 *    `WEBHOOK_MAX_ATTEMPTS` total attempts, then marked `"failed"`;
 *  - redirects are NEVER followed (`redirect: "manual"`): each hop would need
 *    re-validation and could steer a signed request to a different target;
 *  - the target URL is re-validated at send time (same SSRF policy as at
 *    create time — scheme, credentials, private/resolved addresses);
 *  - each request is capped by `WEBHOOK_TIMEOUT_MS`.
 */

const LOG_PREFIX = "[webhooks]";

/** Total attempts per delivery (the initial POST + up to two retries). */
export const WEBHOOK_MAX_ATTEMPTS = 3;

/** Backoff ladder by failed-attempt count: retry 1 after 1m, retry 2 after 5m (30m tail kept for clarity if the attempt cap is raised). */
export const WEBHOOK_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000] as const;

/** Outbound POST timeout. */
export const WEBHOOK_TIMEOUT_MS = 10_000;

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
  status: "pending" | "success" | "failed" | "skipped";
  responseCode?: number | null;
  error?: string;
}

export interface DeliverWebhookOptions {
  now?: Date;
  timeoutMs?: number;
}

/**
 * Performs (or retries) one webhook delivery: claims the row atomically,
 * re-validates the URL, POSTs the signed payload, and records success or
 * schedules the next attempt. Never throws — all outcomes land in the row.
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
      webhook: { select: { id: true, url: true, encryptedSecret: true, isEnabled: true } },
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

  // Atomic claim: bump `attempts` only while the row is still pending so the
  // inline pass and the scheduler can never double-deliver the same event.
  const claim = (await prisma.webhookDelivery.updateMany({
    where: { id: delivery.id, status: "pending" },
    data: { attempts: { increment: 1 } },
  })) as WebhookUpdateManyResult;
  if (claim.count === 0) {
    return { status: "skipped", error: "Delivery already claimed by another worker" };
  }
  const attempts = delivery.attempts + 1;

  // SSRF re-validation at send time: the webhook may have been created before
  // an operator-tightened environment, or DNS may have changed since create.
  let targetUrl: string;
  try {
    targetUrl = await assertOutboundUrlAllowed(delivery.webhook.url, {
      label: "Webhook URL",
      allowPrivateHosts: webhookAllowPrivateHosts(),
      privateHostsHint: "Set WEBHOOK_ALLOW_PRIVATE_HOSTS=true to allow webhook delivery to private, self-hosted targets",
    });
  } catch (error) {
    if (!(error instanceof OutboundUrlValidationError)) {
      throw error;
    }
    await recordFailure(prisma, delivery.id, attempts, now, error.message, null);
    return { status: attempts >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending", responseCode: null, error: error.message };
  }

  const secret = decryptSecret(delivery.webhook.encryptedSecret);
  const body = buildDeliveryBody(delivery.payload, delivery.id);
  const timestamp = Math.floor(now.getTime() / 1000).toString();
  const signature = computeWebhookSignature(secret, timestamp, body);

  const outcome = await postWebhookRequest(targetUrl, {
    body,
    event: delivery.event,
    deliveryId: delivery.id,
    signature,
    timestamp,
    timeoutMs: options.timeoutMs,
  });

  if (outcome.ok && outcome.responseCode !== null) {
    await prisma.webhookDelivery.updateMany({
      where: { id: delivery.id, status: "pending" },
      data: {
        status: "success",
        responseCode: outcome.responseCode,
        attempts: { set: attempts },
        lastError: null,
        nextAttemptAt: now,
      },
    });
    return { status: "success", responseCode: outcome.responseCode };
  }

  await recordFailure(prisma, delivery.id, attempts, now, outcome.error ?? "Webhook delivery failed", outcome.responseCode);
  return {
    status: attempts >= WEBHOOK_MAX_ATTEMPTS ? "failed" : "pending",
    responseCode: outcome.responseCode,
    error: outcome.error ?? undefined,
  };
}

async function recordFailure(
  prisma: PrismaClient,
  deliveryId: string,
  attempts: number,
  now: Date,
  errorMessage: string,
  responseCode: number | null,
) {
  const exhausted = attempts >= WEBHOOK_MAX_ATTEMPTS;
  const delay = WEBHOOK_RETRY_DELAYS_MS[Math.min(attempts - 1, WEBHOOK_RETRY_DELAYS_MS.length - 1)];
  const nextAttemptAt = exhausted ? now : new Date(now.getTime() + delay);

  await prisma.webhookDelivery.updateMany({
    where: { id: deliveryId, status: "pending" },
    data: {
      attempts: { set: attempts },
      ...(exhausted ? { status: "failed" } : {}),
      responseCode,
      lastError: errorMessage,
      nextAttemptAt,
    },
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
}

interface WebhookPostResult {
  ok: boolean;

  /** HTTP status when a response arrived, null on transport/timeout errors. */
  responseCode: number | null;
  /** Taskito-authored error description; upstream response bodies are never reflected. */
  error: string | null;
}

/**
 * The single outbound HTTP hop shared by deliveries and `ping` tests:
 * POST JSON with the X-Taskito-* headers, 10s timeout, redirects refused
 * (manual redirect handling = a 3xx is returned instead of followed and counts
 * as a failure), response bodies drained but never surfaced.
 */
export async function postWebhookRequest(url: string, init: WebhookPostInit): Promise<WebhookPostResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Taskito-Webhook/1.0",
        [WEBHOOK_EVENT_HEADER.toLowerCase()]: init.event,
        [WEBHOOK_DELIVERY_HEADER.toLowerCase()]: init.deliveryId,
        [WEBHOOK_TIMESTAMP_HEADER.toLowerCase()]: init.timestamp,
        [WEBHOOK_SIGNATURE_HEADER.toLowerCase()]: `sha256=${init.signature}`,
      },
      body: init.body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs ?? WEBHOOK_TIMEOUT_MS),
    });

    // Drain (best-effort) so the socket is released; never inspect or reflect
    // the response body — it could contain anything the receiver controls.
    try {
      await response.arrayBuffer();
    } catch {
      // ignore
    }

    if (!response.ok) {
      return { ok: false, responseCode: response.status, error: `Webhook responded with HTTP status ${response.status}` };
    }
    return { ok: true, responseCode: response.status, error: null };
  } catch (error) {
    const normalizedName = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    const message = normalizedName
      ? `Webhook request timed out after ${Math.ceil((init.timeoutMs ?? WEBHOOK_TIMEOUT_MS) / 1000)} seconds`
      : describeError(error) || "Webhook request failed";
    return { ok: false, responseCode: null, error: boundedError(message, "Webhook request failed") };
  }
}

/**
 * Fans one event out to every enabled+subscribed webhook of the project:
 * creates a `WebhookDelivery` row per webhook (status `pending`, due now) and
 * kicks delivery off fire-and-forget. Callers invoke it with
 * `void emitWebhookEvent(...).catch(() => {})` so it can never fail a
 * mutation; slice/part failures inside only affect the fan-out itself.
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
      select: { id: true },
    }),
  ]);

  if (!project || webhooks.length === 0) {
    return { delivered: 0 };
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

  let delivered = 0;
  for (const webhook of webhooks) {
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

    delivered += 1;

    // Fire-and-forget: enqueue the POST without waiting; the scheduler sweep
    // is the safety net for anything left pending (restart, transient failure).
    void deliverWebhook(prisma, created.id).catch(() => {});
  }

  return { delivered };
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
  });
}

/**
 * Scheduler-facing sweep: delivers every still-`pending` delivery whose
 * `nextAttemptAt` has come due. Each delivery is isolated (failures are
 * logged, never abort the sweep) and claim-guarded inside `deliverWebhook`.
 */
export async function processDueWebhookDeliveries(
  prisma: PrismaClient,
  now: Date = new Date(),
  options: { limit?: number } = {},
): Promise<{ processed: number; succeeded: number }> {
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
    try {
      const result = await deliverWebhook(prisma, delivery.id, { now });
      if (result.status === "success") {
        succeeded += 1;
      }
    } catch (error) {
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
 * error }` — bounded error text, no upstream body reflection. Never persists
 * a delivery row.
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
  },
): Promise<SendWebhookPingResult> {
  const now = input.now ?? new Date();

  let targetUrl: string;
  try {
    targetUrl = await assertOutboundUrlAllowed(input.url, {
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

  const result = await postWebhookRequest(targetUrl, {
    body,
    event: WEBHOOK_PING_EVENT,
    deliveryId,
    timestamp,
    signature,
    timeoutMs: input.timeoutMs,
  });

  return {
    status: result.ok ? "success" : "failed",
    responseCode: result.responseCode,
    error: result.error,
  };
}