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
  let rowOverrides: Record<string, unknown>;

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("AI_SECRET_MASTER_KEY", MASTER_KEY);
    vi.stubEnv("AUTH_SECRET", "router-test-auth-secret");
    prisma = createPrismaMock();
    wireAccessMocks(prisma, userId);
    prisma.aiProviderConnection.findFirst.mockResolvedValue(buildProviderRow());
    storedSummary = null;
    rowOverrides = {};
    // The cache write is a CAS updateMany: it only lands while the row still
    // carries the updatedAt it was read with. The mock replays that contract:
    // a where.updatedAt that no longer matches the current row returns 0 and
    // persists nothing.
    prisma.task.updateMany.mockImplementation(async (
      { where, data }: { where: { updatedAt?: Date }; data: { aiSummary: Record<string, unknown>; updatedAt: Date } },
    ) => {
      const currentUpdatedAt = (rowOverrides.updatedAt as Date | undefined) ?? updatedAtV1;
      if (where.updatedAt && where.updatedAt.getTime() !== currentUpdatedAt.getTime()) {
        return { count: 0 };
      }
      storedSummary = data.aiSummary;
      return { count: 1 };
    });
    prisma.task.findUnique.mockImplementation(async () =>
      buildTaskRow({ ...(storedSummary ? { aiSummary: storedSummary } : {}), ...rowOverrides })
    );
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
    rowOverrides = overrides;
  }

  function summaryResponse(text: string) {
    return openAiContent(JSON.stringify({
      summary: text,
      decisions: [`${text} decision`],
      openQuestions: [],
      nextSteps: [],
    }));
  }

  it("generates once, serves the cache while the task content is unchanged, and regenerates otherwise", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      summaryResponse("First summary."),
      summaryResponse("Second summary."),
      summaryResponse("Forced summary."),
    ]);
    restoreFake = fake.restore;
    mockTask();

    const caller = makeCaller(prisma, userId);

    // 1) Cold: generates and CAS-writes { v, generatedAt, forContentHash, result }.
    const first = await caller.summarizeTask({ taskId });
    expect(first.cached).toBe(false);
    expect(first.summary).toBe("First summary.");
    expect(fake.requests).toHaveLength(1);
    expect(prisma.task.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.task.update).not.toHaveBeenCalled();
    const storedPayload = storedSummary as Record<string, unknown>;
    expect(storedPayload.v).toBe(2);
    expect(storedPayload.forContentHash).toEqual(expect.any(String));
    expect(storedPayload.forUpdatedAt).toBeUndefined();
    expect(storedPayload.generatedAt).toEqual(expect.any(String));
    expect(storedPayload.result).toEqual(expect.objectContaining({ summary: "First summary." }));

    // The write is a CAS on the pre-call updatedAt AND pins the write's
    // updatedAt to the same value (never an older timestamp, never a bump).
    const casCall = prisma.task.updateMany.mock.calls[0][0] as {
      where: { id: string; updatedAt: Date; comments: unknown };
      data: { updatedAt: Date };
    };
    expect(casCall.where.id).toBe(taskId);
    expect(casCall.where.updatedAt).toEqual(updatedAtV1);
    expect(casCall.data.updatedAt).toBe(casCall.where.updatedAt);
    // The CAS also guards the newest comment: it must still exist and stay newest.
    expect(casCall.where.comments).toEqual({
      some: { createdAt: commentAtV1 },
      none: { createdAt: { gt: commentAtV1 } },
    });

    // 2) Same task content → cached, no provider call.
    const second = await caller.summarizeTask({ taskId });
    expect(second).toEqual({
      summary: "First summary.",
      decisions: ["First summary. decision"],
      openQuestions: [],
      nextSteps: [],
      generatedAt: storedPayload.generatedAt,
      cached: true,
      persisted: true,
    });
    expect(fake.requests).toHaveLength(1);
    expect(prisma.task.updateMany).toHaveBeenCalledTimes(1);

    // 3) Task edit (updatedAt bumped + newest comment changed) → regenerates.
    mockTask({
      updatedAt: updatedAtV2,
      comments: [{ ...buildTaskRow().comments[0], id: "clxcomment000000000000000003", createdAt: commentAtV2 }, buildTaskRow().comments[0]],
    });
    const third = await caller.summarizeTask({ taskId });
    expect(third.cached).toBe(false);
    expect(third.summary).toBe("Second summary.");
    expect(fake.requests).toHaveLength(2);
    expect(prisma.task.updateMany).toHaveBeenCalledTimes(2);
    expect((storedSummary as Record<string, unknown>).forContentHash).not.toBe(storedPayload.forContentHash);

    // 4) force: true bypasses a valid cache.
    const forced = await caller.summarizeTask({ taskId, force: true });
    expect(forced.cached).toBe(false);
    expect(forced.summary).toBe("Forced summary.");
    expect(fake.requests).toHaveLength(3);
  });

  // CITADEL-amv (finding 11): the task is edited while the provider call is
  // in flight. The old implementation unconditionally wrote the summary and
  // restored the old updatedAt, so the next request served the stale body-A
  // summary for the new body. The CAS must discard the stale summary, persist
  // nothing, and never move updatedAt backward.
  it("discards the summary and persists nothing when the task is edited while the model runs", async () => {
    restoreEnv = stubFakeProviderEnv();
    let midFlightEditApplied = false;
    const fake = installFakeFetch([
      async () => {
        // Concurrent edit lands between the task read and the cache write:
        // body changes and updatedAt advances.
        midFlightEditApplied = true;
        mockTask({ body: "Escalated: 401s now affect all tenants.", updatedAt: updatedAtV2 });
        return summaryResponse("Stale body-A summary.");
      },
      summaryResponse("Fresh body-B summary."),
    ]);
    restoreFake = fake.restore;
    mockTask();

    const caller = makeCaller(prisma, userId);

    const first = await caller.summarizeTask({ taskId });
    expect(midFlightEditApplied).toBe(true);
    expect(first.cached).toBe(false);
    expect(first.persisted).toBe(false);
    expect(first.summary).toBe("Stale body-A summary.");
    // The CAS lost (count 0): nothing was persisted — no cache entry, no
    // second write, and updatedAt was never touched.
    expect(storedSummary).toBeNull();
    expect(prisma.task.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.task.update).not.toHaveBeenCalled();
    const casCall = prisma.task.updateMany.mock.calls[0][0] as {
      where: { updatedAt: Date };
      data: { updatedAt: Date };
    };
    expect(casCall.where.updatedAt).toEqual(updatedAtV1);
    expect(casCall.data.updatedAt).toBe(casCall.where.updatedAt);

    // A new comment-only change (updatedAt untouched) must also invalidate:
    // the comment thread is part of the content hash.
    // (Covered separately below; here the body edit already changed the hash.)

    // The next request must NOT serve body A's summary for body B.
    const second = await caller.summarizeTask({ taskId });
    expect(second.cached).toBe(false);
    expect(second.persisted).toBe(true);
    expect(second.summary).toBe("Fresh body-B summary.");
    expect(fake.requests).toHaveLength(2);
    expect((storedSummary as Record<string, unknown>).result).toEqual(
      expect.objectContaining({ summary: "Fresh body-B summary." }),
    );

    // And once persisted for body B, the cache serves body B's summary.
    const third = await caller.summarizeTask({ taskId });
    expect(third.cached).toBe(true);
    expect(third.summary).toBe("Fresh body-B summary.");
    expect(fake.requests).toHaveLength(2);
  });

  it("invalidates the cache when a new comment arrives without bumping task.updatedAt", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      summaryResponse("Summary before comment."),
      summaryResponse("Summary after comment."),
    ]);
    restoreFake = fake.restore;
    mockTask();

    const caller = makeCaller(prisma, userId);
    const first = await caller.summarizeTask({ taskId });
    expect(first.cached).toBe(false);

    // Comment creation does not bump task.updatedAt — only the thread grows.
    const newerCommentAt = new Date("2026-05-22T10:00:00.000Z");
    mockTask({
      comments: [
        { ...buildTaskRow().comments[0], id: "clxcomment000000000000000004", content: "Newest comment.", createdAt: newerCommentAt },
        ...buildTaskRow().comments,
      ],
    });

    const second = await caller.summarizeTask({ taskId });
    expect(second.cached).toBe(false);
    expect(second.summary).toBe("Summary after comment.");
    expect(fake.requests).toHaveLength(2);
    // The losing CAS would have targeted the stale newest comment; the
    // winning write pins the new one.
    const casCall = prisma.task.updateMany.mock.calls[1][0] as {
      where: { comments: { none: { createdAt: { gt: Date } } } };
    };
    expect(casCall.where.comments.none.createdAt.gt).toEqual(newerCommentAt);
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
