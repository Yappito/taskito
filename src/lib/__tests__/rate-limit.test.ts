import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { consumeRateLimit, resetRateLimit } from "@/lib/rate-limit";
import { searchRouter } from "@/server/routers/search";
import { callerFor, memberOf } from "@/test/actors";

vi.mock("@/server/services/task-search", () => ({
  searchTasks: vi.fn(async () => ({ hits: [], totalHits: 0, processingTimeMs: 0 })),
}));

const OPTIONS = { maxAttempts: 3, windowMs: 1000 };

describe("consumeRateLimit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to maxAttempts then denies", () => {
    const bucket = "test-n-then-deny";
    const key = "key-1";

    expect(consumeRateLimit(bucket, key, OPTIONS)).toMatchObject({ allowed: true, remaining: 2 });
    expect(consumeRateLimit(bucket, key, OPTIONS)).toMatchObject({ allowed: true, remaining: 1 });
    expect(consumeRateLimit(bucket, key, OPTIONS)).toMatchObject({ allowed: true, remaining: 0 });
    expect(consumeRateLimit(bucket, key, OPTIONS)).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it("tracks bucket keys independently", () => {
    const bucket = "test-key-isolation";

    expect(consumeRateLimit(bucket, "key-a", OPTIONS)).toMatchObject({ allowed: true });
    expect(consumeRateLimit(bucket, "key-a", OPTIONS)).toMatchObject({ allowed: true });
    expect(consumeRateLimit(bucket, "key-b", OPTIONS)).toMatchObject({
      allowed: true,
      remaining: 2,
    });
  });

  it("resets when the window expires", () => {
    const bucket = "test-window-expiry";
    const key = "key-1";

    consumeRateLimit(bucket, key, OPTIONS);
    consumeRateLimit(bucket, key, OPTIONS);
    consumeRateLimit(bucket, key, OPTIONS);
    expect(consumeRateLimit(bucket, key, OPTIONS).allowed).toBe(false);

    // Still inside the window (resetAt = first attempt + windowMs): denied.
    vi.advanceTimersByTime(500);
    expect(consumeRateLimit(bucket, key, OPTIONS).allowed).toBe(false);

    // One millisecond past resetAt: a fresh window begins.
    vi.advanceTimersByTime(501);
    expect(consumeRateLimit(bucket, key, OPTIONS)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it("clears accumulated attempts via resetRateLimit", () => {
    const bucket = "test-reset-rate-limit";
    const key = "key-1";

    consumeRateLimit(bucket, key, OPTIONS);
    consumeRateLimit(bucket, key, OPTIONS);
    resetRateLimit(bucket, key);

    expect(consumeRateLimit(bucket, key, OPTIONS)).toMatchObject({ allowed: true, remaining: 2 });
  });
});

describe("searchRouter.query rate limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws the rate-limit error on the 31st call within one minute", async () => {
    // The limiter keeps its store at module level keyed by the session user
    // id, so this test uses a unique caller id for isolation.
    const uniqueUserId = "cmab8yxxp0000r0a0t0e0l0i0m0i0t0";
    const projectId = "cmab8yxxp0001s0e0a0r0c0h0p0r0j0";
    const actor = memberOf({ userId: uniqueUserId, projects: { [projectId]: "member" } });
    const caller = callerFor(searchRouter, actor.prisma, actor.sessionUser);
    const query = caller.query as (input?: unknown) => Promise<unknown>;

    const input = { query: "needle", projectId, offset: 0, limit: 20 };
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      await expect(query(input)).resolves.toEqual({
        hits: [],
        totalHits: 0,
        processingTimeMs: 0,
      });
    }

    await expect(query(input)).rejects.toThrow("Search rate limit exceeded");
  });

  it("allows the same caller again once the sixty second window expires", async () => {
    const uniqueUserId = "cmab8yxxp0000r0a0t0e0l0w0i0n0d0";
    const projectId = "cmab8yxxp0002s0e0a0r0c0h0p0r0j0";
    const actor = memberOf({ userId: uniqueUserId, projects: { [projectId]: "member" } });
    const caller = callerFor(searchRouter, actor.prisma, actor.sessionUser);
    const query = caller.query as (input?: unknown) => Promise<unknown>;

    const input = { query: "needle", projectId, offset: 0, limit: 20 };
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await query(input);
    }
    await expect(query(input)).rejects.toThrow("Search rate limit exceeded");

    vi.advanceTimersByTime(60 * 1000 + 1);
    await expect(query(input)).resolves.toEqual({
      hits: [],
      totalHits: 0,
      processingTimeMs: 0,
    });
  });
});