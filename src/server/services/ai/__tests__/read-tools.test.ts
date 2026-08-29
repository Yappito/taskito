import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPrismaMock } from "@/test/prisma-mock";

vi.mock("@/server/authz", () => ({
  requireProjectAccess: vi.fn().mockResolvedValue({ membershipRole: "owner" }),
}));

vi.mock("@/server/services/task-search", () => ({
  searchTasks: vi.fn(async () => ({
    hits: [
      {
        id: "clxtask0000000000000000000",
        projectId: "clxproject00000000000000000",
        projectSlug: "taskito",
        projectKey: "TASK",
        taskNumber: 12,
        title: "Fix the login flow",
        description: "Login redirects to the wrong page.",
        status: { id: "status-1", name: "In Progress", color: "blue" },
        priority: "high",
        dueDate: "2026-06-01T00:00:00.000Z",
        createdAt: "2026-05-01T00:00:00.000Z",
        tags: [{ id: "tag-1", name: "bug", color: "red" }],
        assignee: { id: "user-2", name: "Alex", email: "alex@example.com" },
        comments: [],
        totalHits: undefined,
      },
    ],
    totalHits: 1,
    processingTimeMs: 1,
  })),
}));

import { requireProjectAccess } from "@/server/authz";
import { executeAiReadToolCalls } from "@/server/services/ai/read-tools";
import { searchTasks } from "@/server/services/task-search";

const projectId = "clxproject00000000000000000";
const taskId = "clxtask0000000000000000000";

function createContextPrismaMock() {
  const prisma = createPrismaMock();
  prisma.task.findFirst.mockResolvedValue({
    id: taskId,
    projectId,
    taskNumber: 12,
    title: "Fix the login flow",
    body: "Login redirects to the wrong page.",
    priority: "high",
    dueDate: new Date("2026-06-01T00:00:00.000Z"),
    status: { id: "status-1", name: "In Progress", category: "active", isFinal: false },
    assignee: { id: "user-2", name: "Alex", email: "alex@example.com", image: null },
    creator: { id: "user-1", name: "Pat", email: "pat@example.com", image: null },
    tags: [{ tag: { id: "tag-1", name: "bug", color: "red" } }],
    comments: [],
    sourceLinks: [],
    targetLinks: [],
    customFieldValues: [],
    project: { key: "TASK", slug: "taskito" },
  });
  return prisma;
}

describe("ai read tools", () => {
  beforeEach(() => {
    vi.mocked(requireProjectAccess).mockClear();
  });

  it("executes taskito_search_tasks with clamped limits and project scoping", async () => {
    const prisma = createContextPrismaMock();

    const outcomes = await executeAiReadToolCalls(prisma as never, {
      projectId,
      requestedByUserId: "user-1",
      permissions: ["search_project", "read_current_task", "read_selected_tasks"],
      calls: [{ id: "call_s1", name: "taskito_search_tasks", arguments: { query: "login", limit: 50 } }],
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].toolCallId).toBe("call_s1");
    expect(outcomes[0].name).toBe("taskito_search_tasks");
    const payload = JSON.parse(outcomes[0].content) as { status: string; totalHits: number; results: Array<Record<string, unknown>> };
    expect(payload.status).toBe("ok");
    expect(payload.totalHits).toBe(1);
    expect(payload.results[0]).toMatchObject({ id: taskId, key: "TASK-12", title: "Fix the login flow" });
    // Authz re-check + project-scoped query args.
    expect(requireProjectAccess).toHaveBeenCalledWith(prisma, "user-1", projectId);
    expect(vi.mocked(searchTasks)).toHaveBeenCalledWith(expect.anything(), {
      query: "login",
      projectId,
      limit: 20, // clamped from 50
    });
  });

  it("executes taskito_get_task by task key and serializes with the shared task serializer", async () => {
    const prisma = createContextPrismaMock();

    // resolveTaskReference resolves TASK-12 through the project-scoped lookup.
    prisma.task.findFirst
      .mockResolvedValueOnce({ id: taskId })
      .mockResolvedValueOnce({
        id: taskId,
        projectId,
        taskNumber: 12,
        title: "Fix the login flow",
        body: "Login redirects to the wrong page.",
        priority: "high",
        dueDate: new Date("2026-06-01T00:00:00.000Z"),
        status: { id: "status-1", name: "In Progress", category: "active", isFinal: false },
        assignee: { id: "user-2", name: "Alex", email: "alex@example.com", image: null },
        creator: { id: "user-1", name: "Pat", email: "pat@example.com", image: null },
        tags: [],
        comments: [],
        sourceLinks: [],
        targetLinks: [],
        customFieldValues: [],
        project: { key: "TASK", slug: "taskito" },
      });

    const outcomes = await executeAiReadToolCalls(prisma as never, {
      projectId,
      requestedByUserId: "user-1",
      permissions: ["read_current_task"],
      calls: [{ id: "call_g1", name: "taskito_get_task", arguments: { taskIdOrKey: "TASK-12" } }],
    });

    expect(outcomes[0].content).toContain("\"status\":\"ok\"");
    const payload = JSON.parse(outcomes[0].content) as { task: Record<string, unknown> };
    expect(payload.task).toMatchObject({ id: taskId, key: "TASK-12" });
  });

  it("rejects calls when the matching read permission is missing (no execution)", async () => {
    const prisma = createContextPrismaMock();

    const outcomes = await executeAiReadToolCalls(prisma as never, {
      projectId,
      requestedByUserId: "user-1",
      permissions: ["add_comment"],
      calls: [
        { id: "call_s2", name: "taskito_search_tasks", arguments: { query: "login" } },
        { id: "call_g2", name: "taskito_get_task", arguments: { taskIdOrKey: taskId } },
      ],
    });

    expect(requireProjectAccess).not.toHaveBeenCalled();
    expect(prisma.task.findMany).not.toHaveBeenCalled();
    for (const outcome of outcomes) {
      const payload = JSON.parse(outcome.content) as { status: string; reason: string };
      expect(payload.status).toBe("rejected");
      expect(payload.reason).toContain("read permission");
    }
  });

  it("returns an error outcome when the task reference cannot be resolved", async () => {
    const prisma = createContextPrismaMock();
    prisma.task.findMany.mockResolvedValue([]);
    prisma.task.findFirst.mockResolvedValue(null);

    const outcomes = await executeAiReadToolCalls(prisma as never, {
      projectId,
      requestedByUserId: "user-1",
      permissions: ["search_project", "read_current_task", "read_selected_tasks"],
      calls: [{ id: "call_x", name: "taskito_get_task", arguments: { taskIdOrKey: "DOES-NOT-EXIST" } }],
    });
    const payload = JSON.parse(outcomes[0].content) as { status: string };
    expect(payload.status).toBe("error");
  });
});