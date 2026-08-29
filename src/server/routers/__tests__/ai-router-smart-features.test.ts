import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptAiSecret } from "@/lib/ai-crypto";
import { aiRouter } from "@/server/routers/ai";
import { createCallerFactory } from "@/server/trpc";
import {
  FAKE_PROVIDER_BASE_URL,
  installFakeFetch,
  jsonResponse,
  stubFakeProviderEnv,
} from "@/server/services/ai/__tests__/helpers/fake-provider";
import { createPrismaMock, type PrismaMock } from "@/test/prisma-mock";

const createCaller = createCallerFactory(aiRouter);

const MASTER_KEY = Buffer.alloc(32, 5).toString("base64");

const projectId = "clxproject00000000000000000";
const statusTodoId = "clxstatus00000000000000001";
const adaId = "clxperson00000000000000001";
const backendTagId = "clxtag0000000000000000001";
const providerId = "clxprovider0000000000000001";

// citadel-d77.32 tests: smart quick-add (parseTask), task summary caching
// (summarizeTask), and the breakdown conversation (startBreakdown) — all
// driven through the fake provider harness, no real network, no DB.

function buildProviderRow() {
  return {
    id: providerId,
    scope: "project",
    ownerUserId: null,
    projectId,
    label: "Project fake",
    adapter: "openai_compatible",
    baseUrl: FAKE_PROVIDER_BASE_URL,
    model: "gpt-fake",
    encryptedSecret: encryptAiSecret("sk-router-test"),
    defaultHeaders: null,
    isEnabled: true,
    isDefault: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCaller(prisma: PrismaMock, userId: string, role = "admin") {
  return createCaller({
    prisma: prisma as never,
    session: { user: { id: userId, role } } as never,
  });
}

function openAiContent(content: string, toolCalls: Array<{ id: string; name: string; arguments: string }> = []) {
  return jsonResponse({
    choices: [{
      message: {
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })) } : {}),
      },
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  });
}

function wireAccessMocks(prisma: PrismaMock, userId: string, role = "admin") {
  // requireProjectAccess short-circuits for admins via user.findUnique.
  prisma.user.findUnique.mockResolvedValue({ id: userId, role, disabledAt: null });
  prisma.aiProjectPolicy.findUnique.mockResolvedValue(null);
  prisma.aiProviderConnection.findUnique.mockResolvedValue(null);
}

describe("ai.parseTask (smart quick-add)", () => {
  const userId = "clxuser000000000000000001";
  let prisma: PrismaMock;
  let restoreFake: (() => void) | undefined;
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("AUTH_SECRET", "router-test-auth-secret");
    prisma = createPrismaMock();
    wireAccessMocks(prisma, userId);
    prisma.aiProviderConnection.findFirst.mockResolvedValue(buildProviderRow());
    prisma.workflowStatus.findMany.mockResolvedValue([{ id: statusTodoId, name: "Todo" }]);
    prisma.user.findMany.mockResolvedValue([
      { id: adaId, name: "Ada Lovelace", email: "ada@example.com" },
    ]);
    prisma.tag.findMany.mockResolvedValue([{ id: backendTagId, name: "backend" }]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (restoreFake) {
      restoreFake();
      restoreFake = undefined;
    }
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = undefined;
    }
  });

  it("parses a natural-language request into a resolved draft + unresolved list", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      openAiContent(JSON.stringify({
        title: "Fix login bug",
        dueDate: "2026-05-22",
        priority: "high",
        assignee: "ada",
        tags: ["backend"],
      })),
    ]);
    restoreFake = fake.restore;

    const caller = makeCaller(prisma, userId);
    const result = await caller.parseTask({ projectId, text: "Fix login bug by Friday, high, @ada #backend" });

    expect(result.unresolved).toEqual([]);
    expect(result.draft).toEqual({
      title: "Fix login bug",
      dueDate: "2026-05-22T00:00:00.000Z",
      priority: "high",
      assigneeId: adaId,
      tagIds: [backendTagId],
    });

    // Candidate lists were fetched from the project and sent as user-turn data.
    const body = fake.requests[0].body as { messages: Array<{ role: string; content: string }> };
    const userTurn = body.messages[1].content as string;
    expect(userTurn).toContain("ada@example.com");
    expect(userTurn).toContain("Fix login bug by Friday, high, @ada #backend");
  });

  it("drops references that do not match project candidates and reports them", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      openAiContent(JSON.stringify({
        title: "Fix login bug",
        assignee: "mallory",
        tags: ["nosuchtag"],
      })),
    ]);
    restoreFake = fake.restore;

    const caller = makeCaller(prisma, userId);
    const result = await caller.parseTask({ projectId, text: "Fix login bug @mallory #nosuchtag" });

    expect(result.draft).toEqual({ title: "Fix login bug" });
    expect(result.unresolved).toEqual([
      'assignee "mallory" did not match any project member',
      'tag "nosuchtag" did not match any project tag',
    ]);
  });

  it("surfaces only the fixed parse-failure message for malformed model output", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([openAiContent("I really cannot help with that, sorry.")]);
    restoreFake = fake.restore;

    const caller = makeCaller(prisma, userId);
    await expect(caller.parseTask({ projectId, text: "anything" })).rejects.toThrow(
      "The AI response for quick-add could not be parsed. Try again or fill the form manually."
    );
  });

  it("rejects when no usable provider exists for the project", async () => {
    prisma.aiProviderConnection.findFirst.mockResolvedValue(null);
    const caller = makeCaller(prisma, userId);
    await expect(caller.parseTask({ projectId, text: "hello" })).rejects.toThrow(
      "No AI provider is available for this project"
    );
  });
});

describe("ai.summarizeTask caching", () => {
  const userId = "clxuser000000000000000002";
  const taskId = "clxtask0000000000000000000";

  const updatedAtV1 = new Date("2026-05-20T08:00:00.000Z");
  const updatedAtV2 = new Date("2026-05-21T09:00:00.000Z");
  const commentAtV1 = new Date("2026-05-20T07:00:00.000Z");
  const commentAtV2 = new Date("2026-05-21T06:00:00.000Z");

  function buildTaskRow(overrides: Record<string, unknown> = {}) {
    return {
      id: taskId,
      projectId,
      taskNumber: 7,
      title: "Harden the login flow",
      body: "Users report intermittent 401s.",
      statusId: statusTodoId,
      priority: "high",
      dueDate: new Date("2026-06-01T00:00:00.000Z"),
      startDate: null,
      closedAt: null,
      archivedAt: null,
      createdAt: new Date("2026-05-01T00:00:00.000Z"),
      updatedAt: updatedAtV1,
      aiSummary: null,
      status: { id: statusTodoId, name: "Todo", color: "#888", category: "todo", isFinal: false, projectId, order: 1 },
      project: { key: "TASK" },
      creator: null,
      assignee: null,
      tags: [],
      comments: [
        {
          id: "clxcomment000000000000000002",
          content: "Newest comment.",
          authorId: userId,
          taskId,
          createdAt: commentAtV1,
          updatedAt: commentAtV1,
          author: { id: userId, name: "Jordan", email: "jordan@example.com", image: null },
        },
      ],
      ...overrides,
    };
  }

  let prisma: PrismaMock;
  let restoreFake: (() => void) | undefined;
  let restoreEnv: (() => void) | undefined;
  let storedSummary: Record<string, unknown> | null;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("AUTH_SECRET", "router-test-auth-secret");
    prisma = createPrismaMock();
    wireAccessMocks(prisma, userId);
    prisma.aiProviderConnection.findFirst.mockResolvedValue(buildProviderRow());
    storedSummary = null;
    prisma.task.update.mockImplementation(async ({ data }: { data: { aiSummary: Record<string, unknown> } }) => {
      storedSummary = data.aiSummary;
      return { id: taskId };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (restoreFake) {
      restoreFake();
      restoreFake = undefined;
    }
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = undefined;
    }
  });

  function mockTask(overrides: Record<string, unknown> = {}) {
    prisma.task.findUnique.mockImplementation(async () =>
      buildTaskRow({ ...(storedSummary ? { aiSummary: storedSummary } : {}), ...overrides })
    );
  }

  function summaryResponse(text: string) {
    return openAiContent(JSON.stringify({
      summary: text,
      decisions: [`${text} decision`],
      openQuestions: [],
      nextSteps: [],
    }));
  }

  it("generates once, serves the cache while updatedAt + latest comment are unchanged, and regenerates otherwise", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      summaryResponse("First summary."),
      summaryResponse("Second summary."),
      summaryResponse("Forced summary."),
    ]);
    restoreFake = fake.restore;
    mockTask();

    const caller = makeCaller(prisma, userId);

    // 1) Cold: generates and stores { generatedAt, forUpdatedAt, result }.
    const first = await caller.summarizeTask({ taskId });
    expect(first.cached).toBe(false);
    expect(first.summary).toBe("First summary.");
    expect(fake.requests).toHaveLength(1);
    expect(prisma.task.update).toHaveBeenCalledTimes(1);
    const storedPayload = storedSummary as Record<string, unknown>;
    expect(storedPayload.forUpdatedAt).toBe(updatedAtV1.toISOString());
    expect(storedPayload.forLatestCommentAt).toBe(commentAtV1.toISOString());
    expect(storedPayload.generatedAt).toEqual(expect.any(String));
    expect(storedPayload.result).toEqual(expect.objectContaining({ summary: "First summary." }));

    // 2) Same task.updatedAt + same latest comment time → cached, no provider call.
    const second = await caller.summarizeTask({ taskId });
    expect(second).toEqual({
      summary: "First summary.",
      decisions: ["First summary. decision"],
      openQuestions: [],
      nextSteps: [],
      generatedAt: storedPayload.generatedAt,
      cached: true,
    });
    expect(fake.requests).toHaveLength(1);
    expect(prisma.task.update).toHaveBeenCalledTimes(1);

    // 3) Task edit (updatedAt bumped) → regenerates.
    mockTask({ updatedAt: updatedAtV2, comments: [{ ...buildTaskRow().comments[0], id: "clxcomment000000000000000003", createdAt: commentAtV2 }, buildTaskRow().comments[0]] });
    const third = await caller.summarizeTask({ taskId });
    expect(third.cached).toBe(false);
    expect(third.summary).toBe("Second summary.");
    expect(fake.requests).toHaveLength(2);
    expect(prisma.task.update).toHaveBeenCalledTimes(2);
    expect((storedSummary as Record<string, unknown>).forUpdatedAt).toBe(updatedAtV2.toISOString());
    expect((storedSummary as Record<string, unknown>).forLatestCommentAt).toBe(commentAtV2.toISOString());

    // 4) force: true bypasses a valid cache.
    const forced = await caller.summarizeTask({ taskId, force: true });
    expect(forced.cached).toBe(false);
    expect(forced.summary).toBe("Forced summary.");
    expect(fake.requests).toHaveLength(3);
  });
});

describe("ai.startBreakdown", () => {
  const userId = "clxuser000000000000000003";
  const taskId = "clxtask0000000000000000000";
  const otherTaskId = "clxtask0000000000000999999";
  const conversationId = "clxconv000000000000000000";

  let prisma: PrismaMock;
  let restoreFake: (() => void) | undefined;
  let restoreEnv: (() => void) | undefined;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("AUTH_SECRET", "router-test-auth-secret");
    prisma = createPrismaMock();
    wireAccessMocks(prisma, userId);
    prisma.aiProviderConnection.findFirst.mockResolvedValue(buildProviderRow());
    prisma.aiProviderConnection.findUniqueOrThrow.mockResolvedValue(buildProviderRow());
    prisma.task.findUnique.mockImplementation(async () => ({
      id: taskId,
      projectId,
      statusId: statusTodoId,
      taskNumber: 7,
      title: "Harden the login flow",
      project: { key: "TASK" },
    }));
    prisma.task.findUniqueOrThrow.mockResolvedValue({
      id: taskId,
      projectId,
      taskNumber: 7,
      title: "Harden the login flow",
      project: { key: "TASK" },
    });
    prisma.task.findMany.mockResolvedValue([]);
    prisma.workflowStatus.findMany.mockResolvedValue([]);
    prisma.tag.findMany.mockResolvedValue([]);
    prisma.customField.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([]);
    prisma.project.findUniqueOrThrow.mockResolvedValue({ id: projectId, name: "Taskito" });
    prisma.aiConversation.update.mockResolvedValue({});
    prisma.aiConversation.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: conversationId,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
    prisma.aiMessage.create.mockResolvedValue({ id: "clxmessage00000000000000001" });
    prisma.aiMessage.findMany.mockResolvedValue([
      {
        id: "clxmessage00000000000000001",
        conversationId,
        role: "user",
        content: "Break this task into subtasks",
        toolName: null,
        toolPayload: null,
        toolCalls: null,
        toolCallId: null,
        usage: null,
        isStreaming: false,
        createdAt: new Date(),
      },
    ]);
    let executionCounter = 0;
    prisma.aiActionExecution.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: `clxexecut00000000000000000${(executionCounter += 1)}`,
      errorMessage: null,
      executedPayload: null,
      result: null,
      rollbackStatus: "unavailable",
      rollbackErrorMessage: null,
      rolledBackAt: null,
      rolledBackByUserId: null,
      executedByUserId: null,
      messageId: null,
      toolCallId: null,
      checkpointBefore: null,
      checkpointAfter: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (restoreFake) {
      restoreFake();
      restoreFake = undefined;
    }
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = undefined;
    }
  });

  it("creates a task-scoped approval conversation, seeds the breakdown request, and returns proposals only", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      openAiContent("", [
        {
          id: "call_1",
          name: "taskito_createTask",
          arguments: JSON.stringify({
            title: "Propose subtask",
            summary: "A concrete subtask for the login hardening.",
            taskTitle: "Write regression test for SSO retry",
            dueDate: "2026-06-02",
          }),
        },
        {
          id: "call_2",
          name: "taskito_addLink",
          arguments: JSON.stringify({
            title: "Link subtask",
            summary: "Child subtask linked to the parent task.",
            sourceTaskId: taskId,
            targetTaskId: otherTaskId,
            linkType: "parent",
          }),
        },
      ]),
    ]);
    restoreFake = fake.restore;

    const caller = makeCaller(prisma, userId);
    const result = await caller.startBreakdown({ taskId });

    // Conversation is task-scoped, approval mode, with breakdown permissions.
    expect(prisma.aiConversation.create).toHaveBeenCalledTimes(1);
    const conversationData = prisma.aiConversation.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(conversationData).toEqual(expect.objectContaining({
      projectId,
      taskId,
      mode: "approval",
      createdByUserId: userId,
      providerId,
    }));
    const granted = conversationData.grantedPermissions as string[];
    expect(granted).toEqual(expect.arrayContaining(["create_task", "link_tasks"]));

    // The seeded first user message is the breakdown request with the task key
    // (the second create is the orchestrator's assistant turn).
    expect(prisma.aiMessage.create).toHaveBeenCalledTimes(2);
    const messageData = prisma.aiMessage.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(messageData.role).toBe("user");
    expect(messageData.content).toBe(
      "Break this task into 3–7 concrete subtasks; propose createTask actions with parent/child links to TASK-7. Do not execute anything: leave every proposal for approval."
    );

    // One orchestrator turn ran; proposals come back unexecuted.
    expect(fake.requests).toHaveLength(1);
    expect(result.conversationId).toBe(conversationId);
    expect(result.proposals).toHaveLength(2);
    expect(result.proposals.map((proposal) => proposal.actionType)).toEqual(["createTask", "addLink"]);
    expect(result.proposals.every((proposal) => proposal.status === "proposed")).toBe(true);
    expect(result.proposals.every((proposal) => proposal.executedByUserId === null)).toBe(true);

    const requestBody = fake.requests[0].body as { messages: Array<{ role: string; content: string }> };
    expect(requestBody.messages.some((message) => message.role === "user" && message.content.includes("TASK-7"))).toBe(true);
  });
});
