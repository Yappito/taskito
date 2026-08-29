import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { requireProjectAccess } = vi.hoisted(() => ({
  requireProjectAccess: vi.fn(),
}));

vi.mock("@/server/authz", () => ({
  requireProjectAccess,
  requireTagAccess: vi.fn(),
  requireTaskAccess: vi.fn(),
  requireTaskLinkAccess: vi.fn(),
  requireWorkflowStatusAccess: vi.fn(),
  canAccessProject: vi.fn(),
  getCurrentActor: vi.fn(),
}));

import { createCallerFactory } from "@/server/trpc";
import { taskRouter } from "@/server/routers/task";

const createCaller = createCallerFactory(taskRouter);

const PROJECT_ID = "cmab8yxxp0001i7p4k8n2v3q4";
const USER_ID = "cmab8yxxp0002i7p4k8n2v3q5";

function createPrismaMock() {
  const prisma = {
    task: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
  };
  return prisma;
}

function createTask(id: string) {
  return {
    id,
    projectId: PROJECT_ID,
    title: `Task ${id}`,
    statusId: "cmab8yxxp0003i7p4k8n2v3q6",
    priority: "medium",
    dueDate: new Date("2026-06-01T12:00:00.000Z"),
    status: { id: "cmab8yxxp0003i7p4k8n2v3q6", name: "Backlog", color: "#888" },
    tags: [],
    creator: null,
    assignee: null,
    participants: [],
    sprint: null,
    timeLogs: [],
    recurrenceRule: null,
    watchers: [],
    sourceLinks: [],
    targetLinks: [],
    project: { key: "TASK" },
  };
}

describe("task router list pagination (count/total path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireProjectAccess.mockResolvedValue({
      actor: { id: USER_ID, role: "owner" },
      membershipRole: "owner",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns totalCount from a count query using the same where clause", async () => {
    const prisma = createPrismaMock();
    const tasks = Array.from({ length: 3 }, (_, index) => createTask(`cmab8yxxp00a${index}i7p4k8n2v3qx`));
    prisma.task.findMany.mockResolvedValue(tasks);
    prisma.task.count.mockResolvedValue(3);

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    const result = await caller.list({ projectId: PROJECT_ID, limit: 100 });

    expect(result.items).toHaveLength(3);
    expect(result.totalCount).toBe(3);
    expect(result.nextCursor).toBeNull();
    expect(prisma.task.count).toHaveBeenCalledTimes(1);
    expect(prisma.task.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectId: PROJECT_ID }),
      })
    );
  });

  it("sets nextCursor and trims the extra item when more tasks exist than the limit", async () => {
    const prisma = createPrismaMock();
    const tasks = Array.from({ length: 4 }, (_, index) => createTask(`cmab8yxxp00b${index}i7p4k8n2v3qx`));
    const extraRowId = tasks[3].id;
    prisma.task.findMany.mockResolvedValue(tasks);
    prisma.task.count.mockResolvedValue(104);

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    const result = await caller.list({ projectId: PROJECT_ID, limit: 3 });

    expect(result.items).toHaveLength(3);
    expect(result.items.map((task) => task.id)).toEqual(tasks.slice(0, 3).map((task) => task.id));
    // the extra row is popped (the router mutates the fetched array) and its id becomes the next-page cursor
    expect(result.nextCursor).toBe(extraRowId);
    expect(result.totalCount).toBe(104);
    // fetches one extra row beyond the limit to detect the next page
    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 4 })
    );
  });

  it("passes the cursor with skip:1 to findMany while counting the same un-cursored where", async () => {
    const prisma = createPrismaMock();
    const cursorTaskId = "cmab8yxxp00c0i7p4k8n2v3qx";
    prisma.task.findMany.mockResolvedValue([createTask("cmab8yxxp00c1i7p4k8n2v3qx")]);
    prisma.task.count.mockResolvedValue(150);

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    const result = await caller.list({ projectId: PROJECT_ID, limit: 1, cursor: cursorTaskId });

    expect(prisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        cursor: { id: cursorTaskId },
        skip: 1,
      })
    );
    // count never receives the cursor — it counts every task matching the filters
    const countWhere = prisma.task.count.mock.calls[0][0].where;
    expect(countWhere).not.toHaveProperty("cursor");
    expect(countWhere).toEqual(expect.objectContaining({ projectId: PROJECT_ID }));
    expect(result.totalCount).toBe(150);
    expect(result.nextCursor).toBeNull();
  });

  it("applies archivedOnly filters identically to the page and count queries", async () => {
    const prisma = createPrismaMock();
    prisma.task.findMany.mockResolvedValue([]);
    prisma.task.count.mockResolvedValue(0);

    const caller = createCaller({
      prisma: prisma as never,
      session: { user: { id: USER_ID } } as never,
    });

    const result = await caller.list({ projectId: PROJECT_ID, archivedOnly: true, limit: 100 });

    expect(result.items).toEqual([]);
    expect(result.totalCount).toBe(0);
    const findManyWhere = prisma.task.findMany.mock.calls[0][0].where;
    const countWhere = prisma.task.count.mock.calls[0][0].where;
    expect(countWhere).toEqual(findManyWhere);
    expect(countWhere.AND).toHaveLength(2);
    expect(countWhere.AND).toEqual([
      { archivedAt: { not: null } },
      { archivedAt: expect.objectContaining({ lte: expect.any(Date) }) },
    ]);
  });
});
