import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AiProviderCompletion } from "@/server/services/ai/provider-openai-compatible";

const { executeAiAction } = vi.hoisted(() => ({
  executeAiAction: vi.fn(),
}));

vi.mock("@/server/services/ai/action-executor", () => ({ executeAiAction }));

import { persistAiAssistantCompletion } from "@/server/services/ai/orchestrator";

const projectId = "clxproject00000000000000000";
const taskId = "clxtask0000000000000000000";
const otherTaskId = "clxtask0000000000000000002";
const userId = "clxuser00000000000000000001";

type YoloConversation = Parameters<typeof persistAiAssistantCompletion>[1]["conversation"];

function createConversation(): YoloConversation {
  return {
    id: "clxconv00000000000000000000",
    projectId,
    taskId: null,
    providerId: "clxprov0000000000000000000",
    mode: "yolo",
    grantedPermissions: ["archive_task"],
    selectedTaskIds: null,
  };
}

function createCompletion(taskIds: string[]): AiProviderCompletion {
  return {
    content: "Archiving the tasks you asked about.",
    toolCalls: taskIds.map((id, index) => ({
      name: "taskito_archiveTask",
      arguments: {
        title: `Archive task ${index + 1}`,
        summary: `Archives task ${id}.`,
        taskId: id,
      },
    })),
  };
}

function createPrismaMock() {
  let counter = 0;
  const prisma = {
    aiMessage: {
      create: vi.fn().mockResolvedValue({ id: "msg-1" }),
    },
    aiActionExecution: {
      create: vi.fn(async (input: { data: Record<string, unknown> }) => {
        counter += 1;
        return { id: `exec-${counter}`, ...input.data };
      }),
      update: vi.fn(async (input: { where: { id: string }; data: Record<string, unknown> }) => ({
        id: input.where.id,
        ...input.data,
      })),
    },
  };
  return prisma;
}

describe("yolo orchestrator execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("executes yolo proposals sequentially in proposal order", async () => {
    const prisma = createPrismaMock();
    const invocationOrder: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    executeAiAction.mockImplementation(async (_client: unknown, input: { actionExecution: { id: string } }) => {
      invocationOrder.push(input.actionExecution.id);
      if (invocationOrder.length === 1) {
        await firstGate;
      }
      return { id: input.actionExecution.id };
    });

    const pending = persistAiAssistantCompletion(prisma as never, {
      conversation: createConversation(),
      requestedByUserId: userId,
      completion: createCompletion([taskId, otherTaskId]),
    });

    await vi.waitFor(() => expect(invocationOrder).toEqual(["exec-1"]));
    expect(executeAiAction).toHaveBeenCalledTimes(1);

    releaseFirst();
    await pending;

    expect(invocationOrder).toEqual(["exec-1", "exec-2"]);
    expect(prisma.aiActionExecution.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: "exec-1" },
        data: expect.objectContaining({ status: "executed" }),
      })
    );
    expect(prisma.aiActionExecution.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: "exec-2" },
        data: expect.objectContaining({ status: "executed" }),
      })
    );
  });

  it("marks only the failing execution as failed and still runs the rest", async () => {
    const prisma = createPrismaMock();
    executeAiAction
      .mockResolvedValueOnce({ id: "exec-1" })
      .mockRejectedValueOnce(new Error("boom"));

    await persistAiAssistantCompletion(prisma as never, {
      conversation: createConversation(),
      requestedByUserId: userId,
      completion: createCompletion([taskId, otherTaskId]),
    });

    expect(executeAiAction).toHaveBeenCalledTimes(2);
    expect(prisma.aiActionExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "exec-1" },
        data: expect.objectContaining({ status: "executed" }),
      })
    );
    expect(prisma.aiActionExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "exec-2" },
        data: expect.objectContaining({ status: "failed", errorMessage: "boom" }),
      })
    );
  });

  it("marks the execution failed when persisting a successful execution fails", async () => {
    const prisma = createPrismaMock();
    executeAiAction.mockResolvedValue({ id: "exec-1" });
    prisma.aiActionExecution.update.mockImplementation(
      async (input: { where: { id: string }; data: { status?: string } }) => {
        if (input.data.status === "executed") {
          throw new Error("persist boom");
        }
        return { id: input.where.id, ...input.data };
      }
    );

    await persistAiAssistantCompletion(prisma as never, {
      conversation: createConversation(),
      requestedByUserId: userId,
      completion: createCompletion([taskId]),
    });

    expect(executeAiAction).toHaveBeenCalledTimes(1);
    expect(prisma.aiActionExecution.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "exec-1" },
        data: expect.objectContaining({ status: "failed", errorMessage: "persist boom" }),
      })
    );
  });
});
