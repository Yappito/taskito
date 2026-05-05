import { describe, expect, it, vi } from "vitest";

vi.mock("@/server/authz", () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ actor: { id: "user-1", role: "admin" }, membershipRole: "owner" }),
  requireTaskAccess: vi.fn().mockResolvedValue({ id: "task-1", projectId: "project-1", statusId: "status-1" }),
}));

import { buildAiConversationContext } from "@/server/services/ai/context-builder";

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

function createPrismaMock() {
  return {
    project: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "project-1", name: "Taskito", key: "TASK", slug: "taskito" }),
    },
    workflowStatus: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    tag: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    customField: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    projectMember: {
      findMany: vi.fn().mockResolvedValue([{ user: { id: "user-1", name: "Pat", email: "pat@example.com", image: null } }]),
    },
    task: {
      findUnique: vi.fn().mockResolvedValue(detailedTask),
      findMany: vi
        .fn()
        .mockResolvedValueOnce([detailedTask])
        .mockResolvedValueOnce([detailedTask]),
    },
  } as unknown as typeof import("@/lib/prisma").prisma;
}

describe("ai context builder", () => {
  it("includes descriptions and recent comments for selected tasks and project task samples", async () => {
    const prisma = createPrismaMock();

    const context = await buildAiConversationContext(prisma, "user-1", {
      projectId: "project-1",
      selectedTaskIds: ["task-1"],
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
    const prisma = createPrismaMock();

    const context = await buildAiConversationContext(prisma, "user-1", {
      projectId: "project-1",
      taskId: "task-1",
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
