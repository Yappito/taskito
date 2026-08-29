import { afterEach, describe, expect, it, vi } from "vitest";

import { createPrismaMock } from "@/test/prisma-mock";

vi.mock("@/server/authz", () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ actor: { id: "user-1", role: "admin" }, membershipRole: "owner" }),
  requireTaskAccess: vi.fn().mockResolvedValue({ id: "task-1", projectId: "project-1", statusId: "status-1" }),
}));

import { buildAiConversationContext, getAiContextMaxChars } from "@/server/services/ai/context-builder";

const detailedTask = {
  id: "task-1",
  taskNumber: 1,
  title: "Draft release notes",
  body: "Detailed task description for the AI.",
  priority: "high",
  dueDate: new Date("2026-05-10T12:00:00.000Z"),
  startDate: null,
  closedAt: null,
  archivedAt: null,
  status: { id: "status-1", name: "In Progress", category: "active", isFinal: false },
  assignee: { id: "user-2", name: "Alex", email: "alex@example.com", image: null },
  creator: { id: "user-1", name: "Pat", email: "pat@example.com", image: null },
  tags: [{ tag: { id: "tag-1", name: "docs", color: "blue" } }],
  customFieldValues: [],
  comments: [
    {
      id: "comment-1",
      content: "Remember to mention the API migration.",
      createdAt: new Date("2026-05-05T10:00:00.000Z"),
      author: { id: "user-3", name: "Jordan", email: "jordan@example.com", image: null },
    },
  ],
  activityEvents: [],
  sourceLinks: [],
  targetLinks: [],
  project: { key: "TASK", slug: "task-project" },
};

/** Shared proxy mock pre-wired with the context-builder's previous defaults. */
function createContextPrismaMock() {
  const prisma = createPrismaMock();
  prisma.project.findUniqueOrThrow.mockResolvedValue({ id: "project-1", name: "Taskito", key: "TASK", slug: "taskito" });
  prisma.workflowStatus.findMany.mockResolvedValue([]);
  prisma.tag.findMany.mockResolvedValue([]);
  prisma.customField.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([{ id: "user-1", name: "Pat", email: "pat@example.com", image: null }]);
  prisma.task.findUnique.mockResolvedValue(detailedTask);
  prisma.task.findMany.mockResolvedValue([detailedTask]);
  return prisma;
}

const readPermissions = ["read_current_task", "read_selected_tasks", "search_project"];

describe("ai context builder", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("includes descriptions and recent comments for selected tasks and project task samples", async () => {
    const prisma = createContextPrismaMock();

    const context = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      selectedTaskIds: ["task-1"],
      permissions: readPermissions,
    });

    expect(context.selectedTasks).toHaveLength(1);
    expect(context.projectTasks).toHaveLength(1);
    expect(context.selectedTasks[0]).toMatchObject({
      body: "Detailed task description for the AI.",
      comments: [
        {
          content: "Remember to mention the API migration.",
          author: { name: "Jordan", email: "jordan@example.com" },
        },
      ],
    });
    expect(context.projectTasks[0]).toMatchObject({
      body: "Detailed task description for the AI.",
      comments: [
        {
          content: "Remember to mention the API migration.",
        },
      ],
    });
  });

  it("already includes description and recent comments for the current task", async () => {
    const prisma = createContextPrismaMock();

    const context = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      taskId: "task-1",
      permissions: readPermissions,
    });

    expect(context.currentTask).toMatchObject({
      body: "Detailed task description for the AI.",
      comments: [
        {
          content: "Remember to mention the API migration.",
        },
      ],
    });
  });
});

describe("ai context permission gating", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("read_only permissions populate all three sections", async () => {
    const prisma = createContextPrismaMock();

    const context = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      taskId: "task-1",
      selectedTaskIds: ["task-1"],
      permissions: ["read_current_task", "read_selected_tasks", "search_project"],
    });

    expect(context.currentTask).not.toBeNull();
    expect(context.selectedTasks).toHaveLength(1);
    expect(context.projectTasks).toHaveLength(1);
    expect(context.truncated).toBe(false);
  });

  it("write-only permissions (no read permissions) receive no task sections", async () => {
    const prisma = createContextPrismaMock();

    const context = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      taskId: "task-1",
      selectedTaskIds: ["task-1"],
      permissions: ["add_comment", "move_status"],
    });

    expect(context.currentTask).toBeNull();
    expect(context.selectedTasks).toEqual([]);
    expect(context.projectTasks).toEqual([]);
});

  it("each read permission gates only its own section", async () => {
    const prisma = createContextPrismaMock();

    const currentOnly = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      taskId: "task-1",
      selectedTaskIds: ["task-1"],
      permissions: ["read_current_task"],
    });
    expect(currentOnly.currentTask).not.toBeNull();
    expect(currentOnly.selectedTasks).toEqual([]);
    expect(currentOnly.projectTasks).toEqual([]);

    const selectedOnly = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      taskId: "task-1",
      selectedTaskIds: ["task-1"],
      permissions: ["read_selected_tasks"],
    });
    expect(selectedOnly.currentTask).toBeNull();
    expect(selectedOnly.selectedTasks).toHaveLength(1);
    expect(selectedOnly.projectTasks).toEqual([]);
  });
});

describe("ai context char budget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function makeTask(index: number) {
    return {
      id: `clxbudgettask${String(index).padStart(14, "0")}`,
      taskNumber: index + 1,
      title: `Budget fixture task ${index + 1}`,
      body: `Body for task ${index + 1}: `.repeat(12),
      priority: "medium",
      dueDate: new Date("2026-06-01T00:00:00.000Z"),
      startDate: null,
      closedAt: null,
      archivedAt: null,
      status: { id: "status-1", name: "In Progress", category: "active", isFinal: false },
      assignee: { id: "user-2", name: "Alex", email: "alex@example.com", image: null },
      creator: { id: "user-1", name: "Pat", email: "pat@example.com", image: null },
      tags: [],
      customFieldValues: [],
      comments: [],
      activityEvents: [],
      sourceLinks: [],
      targetLinks: [],
      project: { key: "TASK", slug: "task-project" },
    };
  }

  it("200-task fixture serializes under the budget with truncated=true", async () => {
    const tasks = Array.from({ length: 200 }, (_, index) => makeTask(index));
    const prisma = createPrismaMock();
    prisma.project.findUniqueOrThrow.mockResolvedValue({ id: "project-1", name: "Taskito", key: "TASK", slug: "taskito" });
    prisma.workflowStatus.findMany.mockResolvedValue([]);
    prisma.tag.findMany.mockResolvedValue([]);
    prisma.customField.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.task.findUnique.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue(tasks);

    vi.stubEnv("AI_CONTEXT_MAX_CHARS", "60000");

    const context = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      permissions: ["search_project"],
    });

    expect(context.truncated).toBe(true);
    // All 200 tasks could not fit: the list was trimmed by the budget.
    expect(context.projectTasks.length).toBeLessThan(200);
    expect(context.projectTasks.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(context, null, 0);
    expect(serialized.length).toBeLessThanOrEqual(60000);
  });

  it("respects AI_CONTEXT_MAX_CHARS env override", async () => {
    const tasks = Array.from({ length: 20 }, (_, index) => makeTask(index));
    const prisma = createPrismaMock();
    prisma.project.findUniqueOrThrow.mockResolvedValue({ id: "project-1", name: "Taskito", key: "TASK", slug: "taskito" });
    prisma.workflowStatus.findMany.mockResolvedValue([]);
    prisma.tag.findMany.mockResolvedValue([]);
    prisma.customField.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.task.findUnique.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue(tasks);

    vi.stubEnv("AI_CONTEXT_MAX_CHARS", "4000");

    expect(getAiContextMaxChars()).toBe(4000);

    const context = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      permissions: ["search_project"],
    });

    expect(context.truncated).toBe(true);
    expect(context.projectTasks.length).toBeLessThan(20);
    expect(JSON.stringify(context, null, 0).length).toBeLessThanOrEqual(4000);
  });

  it("keeps everything with truncated=false when the fixture fits", async () => {
    const tasks = [{ ...makeTask(0), body: "x".repeat(5200) }];
    const prisma = createPrismaMock();
    prisma.project.findUniqueOrThrow.mockResolvedValue({ id: "project-1", name: "Taskito", key: "TASK", slug: "taskito" });
    prisma.workflowStatus.findMany.mockResolvedValue([]);
    prisma.tag.findMany.mockResolvedValue([]);
    prisma.customField.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.task.findUnique.mockResolvedValue(null);
    prisma.task.findMany.mockResolvedValue(tasks);

    const context = await buildAiConversationContext(prisma as never, "user-1", {
      projectId: "project-1",
      permissions: ["search_project"],
    });

    expect(context.projectTasks).toHaveLength(1);
    expect(context.truncated).toBe(false);
    // Bodies over the per-field cap carry the truncation marker.
    expect(JSON.stringify(context)).toContain("…[truncated]");
  });
});
