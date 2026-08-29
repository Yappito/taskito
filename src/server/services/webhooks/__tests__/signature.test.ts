import { describe, expect, it } from "vitest";

import {
  computeWebhookSignature,
  verifyWebhookSignature,
  webhookSignatureInput,
  WEBHOOK_DELIVERY_HEADER,
  WEBHOOK_EVENT_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
} from "@/server/services/webhooks/signature";

// Fixed vector computed independently with `node -e 'crypto.createHmac(...)'`
// (see bead notes) so a change to the signing algorithm, key, or signed
// content breaks this test even if it does not break any other assertion.
const SECRET = "whsec_test_secret";
const TIMESTAMP = "1700000000";
const BODY = JSON.stringify({ a: 1, b: "two" });
const EXPECTED_SIGNATURE = "7d62308e987eabc654815b93ed5e5656ae71f6f314316ce167e47474300fa0e1".slice(0, 64);

describe("webhook signature", () => {
  it("header name constants match the documented X-Taskito-* names", () => {
    expect(WEBHOOK_SIGNATURE_HEADER).toBe("X-Taskito-Signature");
    expect(WEBHOOK_TIMESTAMP_HEADER).toBe("X-Taskito-Timestamp");
    expect(WEBHOOK_EVENT_HEADER).toBe("X-Taskito-Event");
    expect(WEBHOOK_DELIVERY_HEADER).toBe("X-Taskito-Delivery");
  });

  it("signs the exact `<timestamp>.<body>` string", () => {
    expect(webhookSignatureInput(TIMESTAMP, BODY)).toBe(`${TIMESTAMP}.${BODY}`);
  });

  it("matches a known HMAC-SHA256 vector", () => {
    expect(computeWebhookSignature(SECRET, TIMESTAMP, BODY)).toBe(EXPECTED_SIGNATURE);
    expect(computeWebhookSignature(SECRET, TIMESTAMP, BODY)).toHaveLength(64);
  });

  it("produces a different signature for a different secret, timestamp, or body", () => {
    const base = computeWebhookSignature(SECRET, TIMESTAMP, BODY);
    expect(computeWebhookSignature("other-secret", TIMESTAMP, BODY)).not.toBe(base);
    expect(computeWebhookSignature(SECRET, "1700000001", BODY)).not.toBe(base);
    expect(computeWebhookSignature(SECRET, TIMESTAMP, JSON.stringify({ a: 1, b: "twoo" }))).not.toBe(base);
  });

  describe("verifyWebhookSignature", () => {
    it("accepts a signature with the `sha256=` scheme prefix", () => {
      expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, `sha256=${EXPECTED_SIGNATURE}`)).toBe(true);
    });

    it("accepts a bare hex signature without the scheme prefix", () => {
      expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, EXPECTED_SIGNATURE)).toBe(true);
    });

    it("rejects a tampered body", () => {
      expect(verifyWebhookSignature(SECRET, TIMESTAMP, `${BODY} `, `sha256=${EXPECTED_SIGNATURE}`)).toBe(false);
    });

    it("rejects a tampered timestamp", () => {
      expect(verifyWebhookSignature(SECRET, "1700000001", BODY, `sha256=${EXPECTED_SIGNATURE}`)).toBe(false);
    });

    it("rejects the wrong secret", () => {
      expect(verifyWebhookSignature("wrong-secret", TIMESTAMP, BODY, `sha256=${EXPECTED_SIGNATURE}`)).toBe(false);
    });

    it("rejects a missing signature", () => {
      expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, null)).toBe(false);
      expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, undefined)).toBe(false);
      expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, "")).toBe(false);
    });

    it("rejects a signature of the wrong length instead of throwing", () => {
      expect(verifyWebhookSignature(SECRET, TIMESTAMP, BODY, "sha256=deadbeef")).toBe(false);
    });
  });
});
