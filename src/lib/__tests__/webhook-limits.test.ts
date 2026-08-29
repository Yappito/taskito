import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_WEBHOOK_DELIVERY_LEASE_MS,
  DEFAULT_WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH,
  DEFAULT_WEBHOOK_LEASE_MARGIN_MS,
  DEFAULT_WEBHOOK_PREFLIGHT_BUDGET_MS,
  DEFAULT_WEBHOOK_TIMEOUT_MS,
  MAX_WEBHOOK_LEASE_MARGIN_MS,
  MIN_WEBHOOK_LEASE_MARGIN_MS,
  WEBHOOK_TIMEOUT_MS,
  webhookDeliveryLeaseFloorMs,
  webhookDeliveryLeaseMs,
  webhookDeliveryPreflightDeadlineMs,
  webhookDeliveryQueueMaxDepth,
  webhookLeaseMarginMs,
  webhookRequestTimeoutMs,
} from "@/lib/webhook-limits";

describe("webhook delivery limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** The hard floor for the claim lease is one worst-case send cycle. */
  it("derives the lease floor from the preflight budget + one full request timeout", () => {
    vi.stubEnv("WEBHOOK_PREFLIGHT_BUDGET_MS", "30000");
    vi.stubEnv("WEBHOOK_TIMEOUT_MS", "20000");
    expect(webhookDeliveryLeaseFloorMs()).toBe(50_000);
  });

  it("floors the configured lease above preflight + request time regardless of (too small) config", () => {
    // One second is within the old clamp range but below the derived floor:
    // the lease must never fall below preflight budget + POST timeout.
    vi.stubEnv("WEBHOOK_DELIVERY_LEASE_MS", "1000");
    expect(webhookDeliveryLeaseMs()).toBe(webhookDeliveryLeaseFloorMs());
    expect(webhookDeliveryLeaseMs()).toBeGreaterThanOrEqual(webhookDeliveryPreflightDeadlineMs() + webhookRequestTimeoutMs());
  });

  it("keeps the documented default lease when it is above the floor", () => {
    vi.stubEnv("WEBHOOK_PREFLIGHT_BUDGET_MS", "15000");
    vi.stubEnv("WEBHOOK_TIMEOUT_MS", "10000");
    expect(webhookDeliveryLeaseMs()).toBe(DEFAULT_WEBHOOK_DELIVERY_LEASE_MS);
  });

  it("bounds the preflight deadline so preflight + one request can never outlive the lease", () => {
    vi.stubEnv("WEBHOOK_PREFLIGHT_BUDGET_MS", "60000");
    vi.stubEnv("WEBHOOK_TIMEOUT_MS", "60000");
    vi.stubEnv("WEBHOOK_DELIVERY_LEASE_MS", "120000");
    const deadline = webhookDeliveryPreflightDeadlineMs();
    expect(webhookRequestTimeoutMs()).toBe(60_000);
    expect(webhookDeliveryLeaseMs()).toBe(120_000);
    // preflight deadline + request timeout <= lease
    expect(deadline).toBeLessThanOrEqual(webhookDeliveryLeaseMs() - webhookRequestTimeoutMs());
  });

  it("exposes the outbound timeout constant next to the lease floor", () => {
    expect(WEBHOOK_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_WEBHOOK_TIMEOUT_MS).toBe(10_000);
    expect(DEFAULT_WEBHOOK_PREFLIGHT_BUDGET_MS).toBe(15_000);
    expect(DEFAULT_WEBHOOK_DELIVERY_LEASE_MS).toBe(300_000);
  });

  it("treats invalid queue depth values as the documented default (fail closed)", () => {
    vi.stubEnv("WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH", "0");
    expect(webhookDeliveryQueueMaxDepth()).toBe(DEFAULT_WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH);
    vi.stubEnv("WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH", "7");
    expect(webhookDeliveryQueueMaxDepth()).toBe(7);
    vi.stubEnv("WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH", "999999");
    expect(webhookDeliveryQueueMaxDepth()).toBe(DEFAULT_WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH);
  });

  it("defaults the lease-renewal margin to 5s and clamps it to the sane [2s, 60s] window (wave-9 finding 1 + wave-10 finding 1)", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(DEFAULT_WEBHOOK_LEASE_MARGIN_MS).toBe(5_000);
      expect(MIN_WEBHOOK_LEASE_MARGIN_MS).toBe(2_000);
      expect(MAX_WEBHOOK_LEASE_MARGIN_MS).toBe(60_000);
      delete process.env.WEBHOOK_LEASE_MARGIN_MS;
      expect(webhookLeaseMarginMs()).toBe(5_000);
      expect(warnSpy).not.toHaveBeenCalled();
      // Floor (wave-10 finding 1): 0 and tiny values are RAISED to the 2s
      // minimum with a logged warning — a margin below the minimum cannot
      // reliably cover the finalize DB round-trip plus the POST start.
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "0");
      expect(webhookLeaseMarginMs()).toBe(2_000);
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "250");
      expect(webhookLeaseMarginMs()).toBe(2_000);
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "1999");
      expect(webhookLeaseMarginMs()).toBe(2_000);
      expect(warnSpy).toHaveBeenCalledTimes(3);
      // In-range values pass through unchanged.
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "5000");
      expect(webhookLeaseMarginMs()).toBe(5_000);
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "30000");
      expect(webhookLeaseMarginMs()).toBe(30_000);
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "60000");
      expect(webhookLeaseMarginMs()).toBe(60_000);
      // Above the cap the value is CLAMPED down to 60000 (with a warning).
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "60001");
      expect(webhookLeaseMarginMs()).toBe(60_000);
      expect(warnSpy).toHaveBeenCalledTimes(4);
      // Unparseable values still fail closed to the documented default.
      vi.stubEnv("WEBHOOK_LEASE_MARGIN_MS", "banana");
      expect(webhookLeaseMarginMs()).toBe(5_000);
      expect(warnSpy).toHaveBeenCalledTimes(5);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ships the queue-depth default the .env.example documents (100) so code and docs agree", () => {
    // wave-8: the code default and WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH in
    // .env.example must be the SAME value (100); a split invites surprise
    // backpressure differences between documented and actual behavior.
    expect(DEFAULT_WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH).toBe(100);
    delete process.env.WEBHOOK_DELIVERY_QUEUE_MAX_DEPTH;
    expect(webhookDeliveryQueueMaxDepth()).toBe(100);
  });

  it("uses WEBHOOK_TIMEOUT_MS (clamped) as the single POST-timeout source the lease floor derives from", () => {
    vi.stubEnv("WEBHOOK_TIMEOUT_MS", "1000");
    expect(webhookRequestTimeoutMs()).toBe(1_000);
    // Floor = preflight budget + the SAME clamped env value the dispatcher's
    // POST uses — never a frozen constant.
    vi.stubEnv("WEBHOOK_PREFLIGHT_BUDGET_MS", "15000");
    expect(webhookDeliveryLeaseFloorMs()).toBe(16_000);
  });
});