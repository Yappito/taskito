import { describe, expect, it, vi } from "vitest";

const { createTaskActivity, createNotification, notifyTaskWatchers, resolveMentionedUserIds, autoTagTask, evaluateAutomationRules, isAutomationExecutionActive } = vi.hoisted(() => ({
  createTaskActivity: vi.fn(async () => undefined),
  createNotification: vi.fn(async () => undefined),
  notifyTaskWatchers: vi.fn(async () => undefined),
  resolveMentionedUserIds: vi.fn(async () => [] as string[]),
  autoTagTask: vi.fn(async () => undefined),
  evaluateAutomationRules: vi.fn(async () => undefined),
  isAutomationExecutionActive: vi.fn(() => false),
}));

vi.mock("@/server/services/task-activity", () => ({
  createTaskActivity,
}));

vi.mock("@/server/services/notifications", () => ({
  createNotification,
  notifyTaskWatchers,
  resolveMentionedUserIds,
}));

vi.mock("@/server/services/auto-tagger", () => ({
  autoTagTask,
}));

vi.mock("@/server/services/automation-evaluator", () => ({
  evaluateAutomationRules,
  isAutomationExecutionActive,
}));

// NOTE: authz is intentionally NOT mocked — this suite pins the real
// authorization behavior of the task router (Pattern A).
import { createCallerFactory } from "@/server/trpc";
import { taskRouter } from "@/server/routers/task";
import { memberOf } from "@/test/actors";

const createCaller = createCallerFactory(taskRouter);

const PROJECT_A = "cmab8yxxp0001a0p0r0j0e0c0t0a0a0";
const PROJECT_B = "cmab8yxxp0002b0p0r0j0e0c0t0b0b0";
const TASK_ID = "cmab8yxxp0003t0a0s0k0t0a0s0k0a0";
const TASK_IN_B_ID = "cmab8yxxp0004t0a0s0k0i0n0b0b0b0";
const STATUS_ID = "cmab8yxxp0004s0t0a0t0u0s0s0t0a0";

function callerFor(fixedActor: ReturnType<typeof memberOf>) {
  return createCaller({
    prisma: fixedActor.prisma as never,
    session: { user: fixedActor.sessionUser } as never,
  });
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    projectId: PROJECT_A,
    statusId: STATUS_ID,
    taskNumber: 7,
    title: "Task in A",
    description: null,
    body: "Body",
    priority: "medium",
    assigneeId: null,
    dueDate: new Date("2026-06-01T12:00:00.000Z"),
    createdAt: new Date("2026-05-01T12:00:00.000Z"),
    status: { id: STATUS_ID, name: "Todo", color: "#000000" },
    project: { key: "AAA", slug: "project-a" },
    tags: [],
    comments: [],
    participants: [],
    activityEvents: [],
    customFieldValues: [],
    sourceLinks: [],
    targetLinks: [],
    watchers: [],
    timeLogs: [],
    sprint: null,
    recurrenceRule: null,
    creator: null,
    assignee: null,
    ...overrides,
  };
}

describe("task router cross-project authorization", () => {
  it("denies byId for a task whose findUnique reports another project", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_B,
      statusId: STATUS_ID,
    });

    await expect(callerFor(actor).byId({ id: TASK_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("denies update for a task in another project and performs no write", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_B,
      statusId: STATUS_ID,
    });

    await expect(
      callerFor(actor).update({ id: TASK_ID, title: "Hijacked title" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(actor.prisma.task.update).not.toHaveBeenCalled();
  });

  it("denies delete for a task in another project and performs no write", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_B,
      statusId: STATUS_ID,
    });

    await expect(callerFor(actor).delete({ id: TASK_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(actor.prisma.task.delete).not.toHaveBeenCalled();
  });

  it("denies archive for a task in another project and performs no write", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_B,
      statusId: STATUS_ID,
    });

    await expect(callerFor(actor).archive({ id: TASK_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(actor.prisma.task.update).not.toHaveBeenCalled();
  });

  it("denies addComment for a task in another project and performs no write", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_B,
      statusId: STATUS_ID,
    });

    await expect(
      callerFor(actor).addComment({ taskId: TASK_ID, content: "sneaky comment" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(actor.prisma.comment.create).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND for an unknown task", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue(null);

    await expect(callerFor(actor).byId({ id: "cmab8yxxp0009n0o0n0e0x0s0t0a0" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lets a viewer in project B read a task in B but deny updating it", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_B]: "viewer" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_IN_B_ID,
      projectId: PROJECT_B,
      statusId: STATUS_ID,
    });
    actor.prisma.task.findUniqueOrThrow.mockResolvedValue(
      taskRow({ id: TASK_IN_B_ID, projectId: PROJECT_B })
    );

    const task = await callerFor(actor).byId({ id: TASK_IN_B_ID });
    expect(task.id).toBe(TASK_IN_B_ID);

    await expect(
      callerFor(actor).update({ id: TASK_IN_B_ID, title: "Viewer should not rename" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(actor.prisma.task.update).not.toHaveBeenCalled();
  });

  it("lets the member actually update a task inside their own project", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_A,
      statusId: STATUS_ID,
    });
    actor.prisma.task.findUniqueOrThrow.mockResolvedValue({
      assigneeId: null,
      closedAt: null,
      statusId: STATUS_ID,
      priority: "medium",
      sprintId: null,
      participants: [],
    });
    actor.prisma.task.update.mockResolvedValue(taskRow({ title: "Renamed in A" }));

    const updated = await callerFor(actor).update({ id: TASK_ID, title: "Renamed in A" });
    expect(updated.title).toBe("Renamed in A");
  });

  it("lets the member comment on a task inside their own project", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: TASK_ID,
      projectId: PROJECT_A,
      statusId: STATUS_ID,
    });
    actor.prisma.comment.create.mockResolvedValue({ id: "cmab8yxxp0009c0o0m0m0e0n0t0a" });

    const comment = await callerFor(actor).addComment({ taskId: TASK_ID, content: "Looks good" });
    expect(comment).toEqual({ id: "cmab8yxxp0009c0o0m0m0e0n0t0a" });
  });
});

describe("task router bulkUpdate authorization", () => {
  it("rejects a mixed batch of in-project and out-of-project tasks entirely", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });

    // Emulate the real DB semantics: the where clause filters BOTH by id list
    // and by projectId, so only the project-A task is ever returned.
    actor.prisma.task.findMany.mockImplementation(async (args?: {
      where?: { projectId?: string };
    }) =>
      [
        taskRow({ id: TASK_ID, projectId: PROJECT_A }),
        taskRow({ id: TASK_IN_B_ID, projectId: PROJECT_B }),
      ].filter((task) => !args?.where?.projectId || task.projectId === args.where.projectId)
    );

    await expect(
      callerFor(actor).bulkUpdate({
        projectId: PROJECT_A,
        taskIds: [TASK_ID, TASK_IN_B_ID],
        statusId: STATUS_ID,
      })
    ).rejects.toThrow("One or more selected tasks are missing or outside the project");

    // The whole batch must be rejected — no partial writes to the A subset.
    expect(actor.prisma.task.update).not.toHaveBeenCalled();
    expect(actor.prisma.taskTag.createMany).not.toHaveBeenCalled();
    expect(actor.prisma.taskTag.deleteMany).not.toHaveBeenCalled();
  });

  it("bulk-updates a batch that is fully inside the caller's project", async () => {
    const actor = memberOf({ userId: "user-1", projects: { [PROJECT_A]: "member" } });
    actor.prisma.task.findMany.mockImplementation(async (args?: {
      where?: { projectId?: string };
    }) =>
      [taskRow({ id: TASK_ID })].filter(
        (task) => !args?.where?.projectId || task.projectId === args.where.projectId
      )
    );
    actor.prisma.task.update.mockResolvedValue(taskRow());
    actor.prisma.workflowStatus.findUnique.mockResolvedValue({
      id: STATUS_ID,
      projectId: PROJECT_A,
      category: "todo",
      isFinal: false,
      autoArchive: false,
      autoArchiveDays: 0,
    });

    const result = await callerFor(actor).bulkUpdate({
      projectId: PROJECT_A,
      taskIds: [TASK_ID],
      statusId: STATUS_ID,
    });

    expect(result).toEqual({ success: true, updatedCount: 1 });
    expect(actor.prisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TASK_ID } })
    );
  });
});
