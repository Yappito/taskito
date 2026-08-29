import crypto from "node:crypto";

/**
 * Outbound webhook signatures.
 *
 * Every webhook POST carries `X-Taskito-Signature: sha256=<hex>` — the
 * hex-encoded HMAC-SHA256 of the exact request body keyed by the webhook's
 * plaintext secret, using the string `"<timestamp>.<body>"` as signed content
 * (`X-Taskito-Timestamp` is the same unix-seconds string). Receivers recompute
 * the HMAC over the raw bytes they received and compare with a
 * constant-time comparison; the timestamp lets receivers reject replays.
 */

export const WEBHOOK_SIGNATURE_HEADER = "X-Taskito-Signature";
export const WEBHOOK_TIMESTAMP_HEADER = "X-Taskito-Timestamp";
export const WEBHOOK_EVENT_HEADER = "X-Taskito-Event";
export const WEBHOOK_DELIVERY_HEADER = "X-Taskito-Delivery";

/** `<timestamp>.<body>` is the signed content for every webhook POST. */
export function webhookSignatureInput(timestamp: string, body: string) {
  return `${timestamp}.${body}`;
}

/**
 * Hex-encoded HMAC-SHA256 of `"<timestamp>.<body>"` keyed with the webhook
 * secret. The same value must be recomputed on the receiver over the RAW
 * request body before any JSON parsing (reserialization would change bytes).
 */
export function computeWebhookSignature(secret: string, timestamp: string, body: string): string {
  return crypto.createHmac("sha256", secret).update(webhookSignatureInput(timestamp, body)).digest("hex");
}

/**
 * Constant-time verification of an `X-Taskito-Signature` value. Accepts the
 * header value with or without the `sha256=` scheme prefix; guards against
 * missing/absent signature data and any length mismatch before comparing.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string | null | undefined,
): boolean {
  if (!signature) {
    return false;
  }
  const provided = signature.trim().startsWith("sha256=") ? signature.trim().slice("sha256=".length) : signature.trim();
  const expected = computeWebhookSignature(secret, timestamp, body);
  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided, "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}