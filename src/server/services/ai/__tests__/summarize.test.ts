import { describe, expect, it } from "vitest";

import {
  AiSummarizeError,
  SUMMARIZE_TASK_SYSTEM_PROMPT,
  TASK_SUMMARY_MAX_CHARS,
  buildTaskSummaryUserTurn,
  buildTaskSummaryResult,
  isTaskSummaryResult,
  readStoredTaskAiSummary,
  summarizeTask,
} from "@/server/services/ai/summarize";
import {
  installFakeFetch,
  jsonResponse,
  makeFakeProvider,
  stubFakeProviderEnv,
} from "./helpers/fake-provider";

function buildTaskSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: "clxtask0000000000000000000",
    projectId: "clxproject00000000000000000",
    taskNumber: 7,
    title: "Harden the login flow",
    body: "Users report intermittent 401s after the SSO rollout.",
    priority: "high",
    dueDate: new Date("2026-06-01T00:00:00.000Z"),
    status: { id: "clxstatus00000000000000001", name: "In Progress", category: "in_progress", isFinal: false },
    project: { key: "TASK" },
    tags: [{ tag: { id: "clxtag0000000000000000001", name: "backend", color: "#000" } }],
    comments: [
      {
        id: "comment-2",
        content: "We agreed to ship the retry fix before the weekend.",
        createdAt: new Date("2026-05-21T10:00:00.000Z"),
        author: { id: "user-2", name: "Jordan", email: "jordan@example.com", image: null },
      },
      {
        id: "comment-1",
        content: "Still waiting on the IdP logs — can @ada confirm the tenant id?",
        createdAt: new Date("2026-05-20T09:00:00.000Z"),
        author: { id: "user-3", name: "Sam", email: "sam@example.com", image: null },
      },
    ],
    ...overrides,
  };
}

describe("ai summarize service", () => {
  it("serializes the task with the detailed context-builder serializer into a wrapped user turn", () => {
    const generatedAt = "2026-05-21T12:00:00.000Z";
    const turn = buildTaskSummaryUserTurn(buildTaskSnapshot(), generatedAt);

    expect(turn).toContain("<taskito_context>");
    expect(turn).toContain("</taskito_context>");
    expect(turn).toContain(generatedAt);
    // Detailed serializer output: full body, comments with authors, task key.
    expect(turn).toContain("Harden the login flow");
    expect(turn).toContain("Users report intermittent 401s after the SSO rollout.");
    expect(turn).toContain("We agreed to ship the retry fix before the weekend.");
    expect(turn).toContain("Jordan");
    expect(turn).toContain("TASK-7");
  });

  it("bounds the serialized snapshot with a truncation marker", () => {
    const hugeBody = "x".repeat(TASK_SUMMARY_MAX_CHARS + 4000);
    const turn = buildTaskSummaryUserTurn(buildTaskSnapshot({ body: hugeBody }), "2026-05-21T12:00:00.000Z");

    expect(turn.length).toBeLessThan(TASK_SUMMARY_MAX_CHARS + 500);
    expect(turn).toContain("…[truncated]");
  });

  it("summarizes a task snapshot into the structured result via one completion", async () => {
    const restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      jsonResponse({
        choices: [{
          message: {
            content: "```json\n" + JSON.stringify({
              summary: "Login 401s traced to the SSO rollout; retry fix in progress.",
              decisions: ["Ship the retry fix before the weekend."],
              openQuestions: ["Which tenant id does the IdP use?"],
              nextSteps: ["Ada to confirm tenant id.", "Deploy and watch the 401 rate."],
            }) + "\n```",
          },
          finish_reason: "stop",
        }],
      }),
    ]);

    try {
      const result = await summarizeTask(makeFakeProvider("openai_compatible"), buildTaskSnapshot());
      expect(result).toEqual({
        summary: "Login 401s traced to the SSO rollout; retry fix in progress.",
        decisions: ["Ship the retry fix before the weekend."],
        openQuestions: ["Which tenant id does the IdP use?"],
        nextSteps: ["Ada to confirm tenant id.", "Deploy and watch the 401 rate."],
      });

      expect(fake.requests).toHaveLength(1);
      const body = fake.requests[0].body as { messages: Array<{ role: string; content: string }> };
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[0].content).toBe(SUMMARIZE_TASK_SYSTEM_PROMPT);
      expect(body.messages[1].role).toBe("user");
      expect(body.messages[1].content).toContain("<taskito_context>");
    } finally {
      fake.restore();
      restoreEnv();
    }
  });

  it("falls back to bare text as the summary when no JSON envelope is returned", () => {
    const result = buildTaskSummaryResult("Everything is on track; no blockers reported.");
    expect(result).toEqual({
      summary: "Everything is on track; no blockers reported.",
      decisions: [],
      openQuestions: [],
      nextSteps: [],
    });
  });

  it("throws the typed fixed-message error for empty output", () => {
    expect(() => buildTaskSummaryResult("   ")).toThrow(AiSummarizeError);
    try {
      buildTaskSummaryResult("   ");
    } catch (error) {
      expect((error as AiSummarizeError).message).toBe(
        "The AI response for the task summary could not be parsed. Try again."
      );
    }
  });

  it("validates the stored cache shape", () => {
    const valid = {
      generatedAt: "2026-05-21T12:00:00.000Z",
      forUpdatedAt: "2026-05-21T11:00:00.000Z",
      forLatestCommentAt: "2026-05-21T10:00:00.000Z",
      result: { summary: "s", decisions: [], openQuestions: [], nextSteps: ["a"] },
    };
    expect(readStoredTaskAiSummary(valid)).toEqual(valid);
    expect(readStoredTaskAiSummary(valid)?.result).toEqual({
      summary: "s",
      decisions: [],
      openQuestions: [],
      nextSteps: ["a"],
    });
    expect(isTaskSummaryResult(valid.result)).toBe(true);

    expect(readStoredTaskAiSummary(null)).toBeNull();
    expect(readStoredTaskAiSummary("junk")).toBeNull();
    expect(readStoredTaskAiSummary({ ...valid, generatedAt: 42 })).toBeNull();
    expect(readStoredTaskAiSummary({ ...valid, result: { summary: 1 } })).toBeNull();
    expect(readStoredTaskAiSummary({ ...valid, forLatestCommentAt: 7 })).toBeNull();
    expect(isTaskSummaryResult({ summary: "s" })).toBe(false);
  });
});
