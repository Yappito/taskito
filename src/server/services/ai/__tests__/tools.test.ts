import { describe, expect, it, vi } from "vitest";

import { buildAiToolDefinitions, getRequiredPermissionsForActionPayload, normalizeAiNativeToolCalls, normalizeAiNativeToolCallsDetailed, normalizeAiToolProposals, resolveAiActionPayload, validateAiActionPayload } from "@/server/services/ai/tools";

const projectId = "clxproject00000000000000000";
const taskId = "clxtask0000000000000000000";
const otherTaskId = "clxother00000000000000000";

describe("ai tools", () => {
  it("keeps valid create task proposals when create_task is granted", () => {
    const proposals = normalizeAiToolProposals([
      {
        actionType: "createTask",
        title: "Create onboarding task",
        summary: "Adds a missing onboarding task.",
        payload: {
          title: "Write onboarding checklist",
          dueDate: "2026-06-01T12:00:00.000Z",
        },
      },
    ], { projectId, grantedPermissions: ["create_task"] });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].actionType).toBe("createTask");
    expect(proposals[0].payload.title).toBe("Write onboarding checklist");
  });

  it("drops create task proposals without a valid due date", () => {
    const proposals = normalizeAiToolProposals([
      {
        actionType: "createTask",
        title: "Create task",
        summary: "Missing due date should not be executable.",
        payload: { title: "No due date" },
      },
    ], { projectId, grantedPermissions: ["create_task"] });

    expect(proposals).toEqual([]);
  });

  it("restricts bulk update proposals to selected tasks", () => {
    const proposals = normalizeAiToolProposals([
      {
        actionType: "bulkUpdate",
        title: "Archive selected tasks",
        summary: "Attempts to include an unselected task.",
        payload: { taskIds: [taskId, otherTaskId], archive: true },
      },
    ], { projectId, grantedPermissions: ["bulk_update_selected"], selectedTaskIds: [taskId] });

    expect(proposals).toEqual([]);
    expect(() => validateAiActionPayload("bulkUpdate", { taskIds: [otherTaskId], archive: true }, { selectedTaskIds: [taskId] })).toThrow(/selected tasks/);
  });

  it("requires tag permission for editTask tag changes", () => {
    const payload = { taskId, tagIds: ["clxtag0000000000000000000"] };
    expect(getRequiredPermissionsForActionPayload("editTask", payload)).toEqual(["edit_tags"]);

    const proposals = normalizeAiToolProposals([
      {
        actionType: "editTask",
        title: "Retag task",
        summary: "Applies a new tag.",
        payload,
      },
    ], { projectId, grantedPermissions: ["edit_core_fields"] });

    expect(proposals).toEqual([]);
  });

  it("keeps add link proposals that use task keys", () => {
    const proposals = normalizeAiToolProposals([
      {
        actionType: "addLink",
        title: "Link follow-up work",
        summary: "Blocks a task with another task.",
        payload: {
          sourceTaskId: "TASK-12",
          targetTaskId: "TASK-34",
          linkType: "blocks",
        },
      },
    ], { projectId, grantedPermissions: ["link_tasks"] });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.sourceTaskId).toBe("TASK-12");
  });

  it("normalizes depends_on link proposals into Taskito blocks links", () => {
    const proposals = normalizeAiToolProposals([
      {
        actionType: "addLink",
        title: "Link release steps",
        summary: "Make changelog work depend on the README update.",
        payload: {
          sourceTaskId: "TEST-5",
          targetTaskId: "TEST-3",
          linkType: "depends_on",
        },
      },
    ], { projectId, grantedPermissions: ["link_tasks"] });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload).toEqual({
      sourceTaskId: "TEST-3",
      targetTaskId: "TEST-5",
      linkType: "blocks",
    });
  });

  it("resolves task-key link payloads to task ids", async () => {
    const prisma = {
      task: {
        findMany: vi.fn(),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: taskId })
          .mockResolvedValueOnce({ id: otherTaskId }),
      },
      taskLink: {
        findFirst: vi.fn(),
      },
    } as unknown as typeof import("@/lib/prisma").prisma;

    const payload = await resolveAiActionPayload(prisma, projectId, "addLink", {
      sourceTaskId: "TASK-12",
      targetTaskId: "TASK-34",
      linkType: "blocks",
    });

    expect(payload).toMatchObject({
      sourceTaskId: taskId,
      targetTaskId: otherTaskId,
      linkType: "blocks",
    });
  });

  it("resolves remove link proposals by task tuple", async () => {
    const prisma = {
      task: {
        findMany: vi.fn(),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: taskId })
          .mockResolvedValueOnce({ id: otherTaskId }),
      },
      taskLink: {
        findFirst: vi.fn().mockResolvedValue({ id: "clxlink0000000000000000000" }),
      },
    } as unknown as typeof import("@/lib/prisma").prisma;

    const payload = await resolveAiActionPayload(prisma, projectId, "removeLink", {
      sourceTaskId: "TASK-12",
      targetTaskId: "TASK-34",
      linkType: "blocks",
    });

    expect(payload).toMatchObject({
      linkId: "clxlink0000000000000000000",
      sourceTaskId: taskId,
      targetTaskId: otherTaskId,
      linkType: "blocks",
    });
  });

  it("resolves depends_on payloads with the correct blocker direction", async () => {
    const prisma = {
      task: {
        findMany: vi.fn(),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ id: otherTaskId })
          .mockResolvedValueOnce({ id: taskId }),
      },
      taskLink: {
        findFirst: vi.fn(),
      },
    } as unknown as typeof import("@/lib/prisma").prisma;

    const payload = await resolveAiActionPayload(prisma, projectId, "addLink", {
      sourceTaskId: "TEST-5",
      targetTaskId: "TEST-3",
      linkType: "depends_on",
    });

    expect(payload).toMatchObject({
      sourceTaskId: otherTaskId,
      targetTaskId: taskId,
      linkType: "blocks",
    });
  });

  it("resolves add link proposals by exact task title when task keys are unavailable", async () => {
    const prisma = {
      task: {
        findFirst: vi.fn(),
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: taskId }])
          .mockResolvedValueOnce([{ id: otherTaskId }]),
      },
      taskLink: {
        findFirst: vi.fn(),
      },
    } as unknown as typeof import("@/lib/prisma").prisma;

    const payload = await resolveAiActionPayload(prisma, projectId, "addLink", {
      sourceTaskId: "Coordinate non-critical SC2, SC3 and SC4 verification cluster deployment with Aya and Manijeh",
      targetTaskId: "Add new dataflow for Jens' neuvector connection for the Non-Critical Verification clusters",
      linkType: "parent",
    });

    expect(payload).toMatchObject({
      sourceTaskId: taskId,
      targetTaskId: otherTaskId,
      linkType: "parent",
    });
  });
});

describe("ai tool schemas", () => {
  it("renames tasks through the editTask newTitle argument (title is the card label)", () => {
    const proposals = normalizeAiNativeToolCalls([
      {
        id: "call_1",
        name: "taskito_editTask",
        arguments: { title: "Rename TASK-1", summary: "User asked for a rename.", taskId, newTitle: "Actual new name" },
      },
    ], { projectId, grantedPermissions: ["edit_core_fields"] });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.title).toBe("Actual new name");
    expect(proposals[0].toolCallId).toBe("call_1");
  });

  it("accepts customFieldValues with string, number, boolean, and null values", () => {
    const proposals = normalizeAiToolProposals([
      {
        actionType: "editTask",
        title: "Update custom fields",
        summary: "Sets custom field values.",
        payload: {
          taskId,
          customFieldValues: [
            { customFieldId: "clxcfield000000000000000", value: 42 },
            { customFieldId: "clxcfield000000000000001", value: true },
            { customFieldId: "clxcfield000000000000002", value: null },
            { customFieldId: "clxcfield000000000000003", value: "text" },
          ],
        },
      },
    ], { projectId, grantedPermissions: ["edit_custom_fields"] });

    expect(proposals).toHaveLength(1);
    expect(proposals[0].payload.customFieldValues).toHaveLength(4);
  });

  it("gives every tool additionalProperties: false, strict: true, and ID-source descriptions", () => {
    const tools = buildAiToolDefinitions(["read_current_task", "read_selected_tasks", "search_project", "add_comment", "move_status", "edit_core_fields", "edit_tags", "edit_custom_fields", "link_tasks", "assign_task", "create_task", "archive_task"]);

    expect(tools.length).toBeGreaterThan(5);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
      expect(tool.strict).toBe(true);
      expect(tool.description.toLowerCase()).toContain("context");
    }
    const moveStatus = tools.find((tool) => tool.name === "taskito_moveStatus");
    expect(moveStatus).toBeDefined();
    expect(JSON.stringify(moveStatus?.inputSchema)).toContain("context.statuses[].id");
    const editTask = tools.find((tool) => tool.name === "taskito_editTask");
    expect(JSON.stringify(editTask?.inputSchema)).toContain("newTitle");
  });

  it("gates read tools on the read permissions", () => {
    // No permissions: no read tools at all.
    expect(buildAiToolDefinitions([]).map((tool) => tool.name)).not.toContain("taskito_search_tasks");
    expect(buildAiToolDefinitions([]).map((tool) => tool.name)).not.toContain("taskito_get_task");
    // search_project unlocks both search and single-task fetch.
    const withSearch = buildAiToolDefinitions(["search_project"]).map((tool) => tool.name);
    expect(withSearch).toContain("taskito_search_tasks");
    expect(withSearch).toContain("taskito_get_task");
    // A bare read permission gets get_task but not full search.
    const withReadCurrent = buildAiToolDefinitions(["read_current_task"]).map((tool) => tool.name);
    expect(withReadCurrent).toContain("taskito_get_task");
    expect(withReadCurrent).not.toContain("taskito_search_tasks");
  });

  it("reports native proposal drops with toolCallId and reason", () => {
    const result = normalizeAiNativeToolCallsDetailed([
      {
        id: "call_403",
        name: "taskito_archiveTask",
        arguments: { title: "Archive", summary: "Not permitted.", taskId },
      },
      {
        id: "call_bad",
        name: "taskito_bogusAction",
        arguments: { title: "Bogus", summary: "Unknown tool." },
      },
      {
        id: "call_valid",
        name: "taskito_addComment",
        arguments: { title: "Add note", summary: "Adds context.", taskId, content: "hello" },
      },
    ], { projectId, grantedPermissions: ["add_comment"] });

    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0].toolCallId).toBe("call_valid");
    expect(result.drops).toHaveLength(2);
    const permissionDrop = result.drops.find((drop) => drop.toolCallId === "call_403");
    expect(permissionDrop?.name).toBe("taskito_archiveTask");
    expect(permissionDrop?.reason).toContain("missing permission");
    const unknownDrop = result.drops.find((drop) => drop.toolCallId === "call_bad");
    expect(unknownDrop?.reason).toContain("unsupported tool");
  });
});
