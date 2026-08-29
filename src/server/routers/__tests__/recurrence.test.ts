import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireProjectAccess,
  requireTaskAccess,
  getCurrentActor,
  processDueRecurrences,
} = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
  requireTaskAccess: vi.fn(),
  getCurrentActor: vi.fn(),
  processDueRecurrences: vi.fn(),
}));

vi.mock("@/server/authz", () => ({
  requireProjectAccess,
  requireTaskAccess,
  getCurrentActor,
}));

vi.mock("@/server/services/recurrence-processor", () => ({
  processDueRecurrences,
}));

// withSchedulerLock takes the advisory lock on the global prisma client, so
// the lock transaction has to be mockable independently of ctx.prisma.
const { prismaGlobalMock } = vi.hoisted(() => ({
  prismaGlobalMock: {
    $transaction: vi.fn(
      async (callback: (tx: unknown) => unknown) =>
        callback({ $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) }),
    ),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaGlobalMock,
}));

import { createCallerFactory } from "@/server/trpc";
import { recurrenceRouter } from "@/server/routers/recurrence";

const createCaller = createCallerFactory(recurrenceRouter);

const PROJECT_ID = "cmab8yxxp0001i7p4k8n2v3q4";
const USER_ID = "cmab8yxxp0002i7p4k8n2v3q5";
const TASK_ID = "cmab8yxxp0003i7p4k8n2v3q6";
const RULE_ID = "cmab8yxxp0004i7p4k8n2v3q7";
const NOW = new Date("2026-05-19T10:00:00.000Z");

function createPrismaMock() {
  return {
    recurrenceRule: {
      upsert: vi.fn().mockResolvedValue({ id: RULE_ID, taskId: TASK_ID }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(
      async (callback: (tx: unknown) => unknown) =>
        callback({
          $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]),
        }),
    ),
  };
}

function createCallerWith(prisma: ReturnType<typeof createPrismaMock>) {
  return createCaller({
    prisma: prisma as never,
    session: { user: { id: USER_ID } } as never,
  });
}

describe("recurrence router", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();

    requireTaskAccess.mockResolvedValue({ id: TASK_ID, projectId: PROJECT_ID });
    getCurrentActor.mockResolvedValue({ id: USER_ID, role: "owner" });
    requireProjectAccess.mockResolvedValue({ actor: { id: USER_ID, role: "owner" }, membershipRole: "owner" });
    processDueRecurrences.mockResolvedValue({ processed: 0, createdTaskIds: [] });
    prismaGlobalMock.$transaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) =>
        callback({ $queryRaw: vi.fn().mockResolvedValue([{ locked: true }]) }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("set", () => {
    it("rejects a past nextDueDate with a validation error and never writes the rule", async () => {
      const prisma = createPrismaMock();
      const caller = createCallerWith(prisma);

      await expect(
        caller.set({
          taskId: TASK_ID,
          frequency: "weekly",
          interval: 1,
          nextDueDate: new Date("2026-05-15T09:00:00.000Z"),
        }),
      ).rejects.toThrow(/Next due date must be today or later/);

      expect(prisma.recurrenceRule.upsert).not.toHaveBeenCalled();
    });

    it("accepts a nextDueDate at the start of today (server-local midnight) and upserts the rule", async () => {
      const prisma = createPrismaMock();
      const caller = createCallerWith(prisma);
      const startOfToday = new Date("2026-05-19T00:00:00.000Z");

      await caller.set({
        taskId: TASK_ID,
        frequency: "monthly",
        interval: 1,
        dayOfMonth: 19,
        nextDueDate: startOfToday,
      });

      expect(prisma.recurrenceRule.upsert).toHaveBeenCalledTimes(1);
      expect(prisma.recurrenceRule.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { taskId: TASK_ID },
          create: expect.objectContaining({
            taskId: TASK_ID,
            frequency: "monthly",
            interval: 1,
            dayOfMonth: 19,
            nextDueDate: startOfToday,
          }),
          update: expect.objectContaining({
            frequency: "monthly",
            dayOfMonth: 19,
            nextDueDate: startOfToday,
          }),
        }),
      );
    });

    it("rejects a nextDueDate after the recurrence end date", async () => {
      const prisma = createPrismaMock();
      const caller = createCallerWith(prisma);

      await expect(
        caller.set({
          taskId: TASK_ID,
          frequency: "weekly",
          interval: 1,
          nextDueDate: new Date("2026-05-25T09:00:00.000Z"),
          endDate: new Date("2026-05-20T23:59:59.000Z"),
        }),
      ).rejects.toThrow(/Next due date must be on or before the recurrence end date/);

      expect(prisma.recurrenceRule.upsert).not.toHaveBeenCalled();
    });

    it("requires task_update access before writing the rule", async () => {
      const prisma = createPrismaMock();
      const caller = createCallerWith(prisma);
      requireTaskAccess.mockRejectedValue(new Error("forbidden"));

      await expect(
        caller.set({
          taskId: TASK_ID,
          frequency: "daily",
          interval: 1,
          nextDueDate: new Date("2026-05-20T09:00:00.000Z"),
        }),
      ).rejects.toThrow("forbidden");

      expect(prisma.recurrenceRule.upsert).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes the rule for the task", async () => {
      const prisma = createPrismaMock();
      const caller = createCallerWith(prisma);

      await expect(caller.remove({ taskId: TASK_ID })).resolves.toEqual({ success: true });

      expect(requireTaskAccess).toHaveBeenCalledWith(prisma, USER_ID, TASK_ID, { permission: "task_update" });
      expect(prisma.recurrenceRule.deleteMany).toHaveBeenCalledWith({ where: { taskId: TASK_ID } });
    });
  });

  describe("processDue", () => {
    it("requires automation_manage access and delegates to the recurrence processor under the scheduler lock (M8)", async () => {
      const prisma = createPrismaMock();
      const caller = createCallerWith(prisma);
      processDueRecurrences.mockResolvedValue({ processed: 3, createdTaskIds: ["cmab8yxxp000bi7p4k8n2v3qd"] });

      const result = await caller.processDue({ projectId: PROJECT_ID, limit: 10 });

      expect(requireProjectAccess).toHaveBeenCalledWith(prisma, USER_ID, PROJECT_ID, { permission: "automation_manage" });
      expect(processDueRecurrences).toHaveBeenCalledTimes(1);
      expect(processDueRecurrences).toHaveBeenCalledWith(prisma, {
        projectId: PROJECT_ID,
        limit: 10,
      });
      expect(result).toEqual({ processed: 3, createdTaskIds: ["cmab8yxxp000bi7p4k8n2v3qd"] });
      // The processor ran inside the scheduler lock transaction.
      expect(prismaGlobalMock.$transaction).toHaveBeenCalledTimes(1);
    });

    it("returns a skipped result instead of racing a tick that holds the scheduler lock (M8)", async () => {
      const prisma = createPrismaMock();
      const caller = createCallerWith(prisma);
      prismaGlobalMock.$transaction.mockImplementation(
        async (callback: (tx: { $queryRaw: unknown }) => unknown) =>
          callback({ $queryRaw: vi.fn().mockResolvedValue([{ locked: false }]) }),
      );

      const result = await caller.processDue({ projectId: PROJECT_ID });

      expect(result).toEqual({ processed: 0, createdTaskIds: [], skipped: true });
      expect(processDueRecurrences).not.toHaveBeenCalled();
    });
  });
});