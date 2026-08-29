import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  processDueRecurrences,
  prismaMock,
} = vi.hoisted(() => ({
  processDueRecurrences: vi.fn(),
  prismaMock: {
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

vi.mock("@/server/services/recurrence-processor", () => ({
  processDueRecurrences,
}));

import { POST } from "@/app/api/cron/process-recurring/route";

const CRON_SECRET = "test-cron-secret";
const SUCCESS_BODY = { processed: 2, createdTaskIds: ["cmab8yxxp0001i7p4k8n2v3q4"] };

// Stand-in for the interactive-transaction client: the scheduler lock query
// runs on the tx connection.
let txMock: { $queryRaw: ReturnType<typeof vi.fn> };

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
    txMock = { $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) };
    prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof txMock) => unknown) => callback(txMock));
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

  it("delegates to the recurrence processor under the scheduler lock and returns 200 with the result", async () => {
    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(SUCCESS_BODY);
    expect(processDueRecurrences).toHaveBeenCalledTimes(1);
    // M9: the cron route now drives the processor against the tick deadline
    // handed over by the lock helper.
    expect(processDueRecurrences).toHaveBeenCalledWith(prismaMock, { limit: 100, signal: expect.any(AbortSignal) });
    // M8: the processor ran inside the scheduler lock transaction.
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(txMock.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("skips with 409 { skipped: true } when the scheduler lock is held (M8)", async () => {
    txMock.$queryRaw.mockResolvedValue([{ locked: false }]);

    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ skipped: true });
    expect(processDueRecurrences).not.toHaveBeenCalled();
  });

  it("skips with 409 when the lock transaction fails", async () => {
    prismaMock.$transaction.mockRejectedValue(new Error("database unavailable"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ skipped: true });
    expect(processDueRecurrences).not.toHaveBeenCalled();
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