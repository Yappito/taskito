import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  processDueRecurrences,
  prismaMock,
} = vi.hoisted(() => ({
  processDueRecurrences: vi.fn(),
  prismaMock: {
    recurrenceRule: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
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

  it("delegates to the recurrence processor and returns 200 with the result", async () => {
    const response = await POST(postRequest(`Bearer ${CRON_SECRET}`));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(SUCCESS_BODY);
    expect(processDueRecurrences).toHaveBeenCalledTimes(1);
    expect(processDueRecurrences).toHaveBeenCalledWith(prismaMock, { limit: 100 });
  });
});