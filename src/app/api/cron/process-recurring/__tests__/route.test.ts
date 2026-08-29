import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  processDueRecurrences,
  prismaMock,
  lockConnectionMock,
} = vi.hoisted(() => ({
  processDueRecurrences: vi.fn(),
  prismaMock: {
    // The global (shared-pool) client: the scheduler lock must never use it.
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
  },
  lockConnectionMock: {
    tryAdvisoryLock: vi.fn(),
    releaseAdvisoryLock: vi.fn(),
    end: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/server/services/recurrence-processor", () => ({
  processDueRecurrences,
}));

vi.mock("@/server/services/scheduler-lock-connection", () => ({
  createSchedulerLockConnection: () => lockConnectionMock,
}));

import { SCHEDULER_ADVISORY_LOCK_KEY } from "@/server/services/scheduler";
import { POST } from "@/app/api/cron/process-recurring/route";

const CRON_SECRET = "test-cron-secret";
const SUCCESS_BODY = { processed: 2, createdTaskIds: ["cmab8yxxp0001i7p4k8n2v3q4"] };

function postRequest(authorization?: string) {
  return new Request("http://localhost:3000/api/cron/process-recurring", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

describe("POST /api/cron/process-recurring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = CRON_SECRET;
    processDueRecurrences.mockResolvedValue(SUCCESS_BODY);
    lockConnectionMock.tryAdvisoryLock.mockResolvedValue(true);
    lockConnectionMock.releaseAdvisoryLock.mockResolvedValue(undefined);
    lockConnectionMock.end.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("returns 503 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;

    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "Recurring-task cron is not configured" });
    expect(processDueRecurrences).not.toHaveBeenCalled();
  });

  it("returns 503 when CRON_SECRET is empty", async () => {
    process.env.CRON_SECRET = "";

    const response = await POST(postRequest());

    expect(response.status).toBe(503);
    expect(processDueRecurrences).not.toHaveBeenCalled();
  });

  it("returns 401 for a wrong bearer token", async () => {
    const response = await POST(postRequest("Bearer wrong-secret"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(processDueRecurrences).not.toHaveBeenCalled();
  });

  it("returns 401 when the authorization header is missing", async () => {
    const response = await POST(postRequest());

    expect(response.status).toBe(401);
    expect(processDueRecurrences).not.toHaveBeenCalled();
  });

  it("delegates to the recurrence processor under the session scheduler lock and returns 200 with the result", async () => {
    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(SUCCESS_BODY);
    expect(processDueRecurrences).toHaveBeenCalledTimes(1);
    // M9: the cron route drives the processor against the tick deadline
    // handed over by the lock helper.
    expect(processDueRecurrences).toHaveBeenCalledWith(prismaMock, { limit: 100, signal: expect.any(AbortSignal) });
    // M8: the run executed while the scheduler lock was held on the dedicated
    // lock connection — which is NOT the shared pool connection (finding 8).
    expect(lockConnectionMock.tryAdvisoryLock).toHaveBeenCalledWith(SCHEDULER_ADVISORY_LOCK_KEY);
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    // The lock is released and the dedicated connection closed only after the
    // run settled.
    expect(lockConnectionMock.releaseAdvisoryLock).toHaveBeenCalledTimes(1);
    expect(lockConnectionMock.end).toHaveBeenCalledTimes(1);
  });

  it("skips with 409 { skipped: true } when the scheduler lock is held (M8)", async () => {
    lockConnectionMock.tryAdvisoryLock.mockResolvedValue(false);

    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ skipped: true });
    expect(processDueRecurrences).not.toHaveBeenCalled();
    // Not acquired: nothing unlocked, but the dedicated connection is closed.
    expect(lockConnectionMock.releaseAdvisoryLock).not.toHaveBeenCalled();
    expect(lockConnectionMock.end).toHaveBeenCalledTimes(1);
  });

  it("skips with 409 when the lock acquisition fails, without leaking the dedicated connection", async () => {
    lockConnectionMock.tryAdvisoryLock.mockRejectedValue(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ skipped: true });
    expect(processDueRecurrences).not.toHaveBeenCalled();
    expect(lockConnectionMock.end).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("rejects a token of a different length without throwing (L12)", async () => {
    // A wrong-length secret must be rejected (never compared via early-exit
    // equality on the raw strings).
    const response = await POST(postRequest("Bearer x"));

    expect(response.status).toBe(401);
    expect(processDueRecurrences).not.toHaveBeenCalled();
  });
});