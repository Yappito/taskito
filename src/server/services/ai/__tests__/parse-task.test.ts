import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AiParseTaskError,
  PARSE_TASK_SYSTEM_PROMPT,
  extractJsonObjectLoose,
  parseTaskFromText,
} from "@/server/services/ai/parse-task";
import {
  installFakeFetch,
  jsonResponse,
  makeFakeProvider,
  stubFakeProviderEnv,
} from "./helpers/fake-provider";

const statusTodoId = "clxstatus00000000000000001";
const adaId = "clxperson00000000000000001";
const graceId = "clxperson00000000000000002";
const backendTagId = "clxtag0000000000000000001";
const frontendTagId = "clxtag0000000000000000002";

const candidates = {
  statuses: [
    { id: statusTodoId, name: "Todo" },
  ],
  people: [
    { id: adaId, name: "Ada Lovelace", email: "ada@example.com" },
    { id: graceId, name: "Grace Hopper", email: "grace@example.com" },
  ],
  tags: [
    { id: backendTagId, name: "backend" },
    { id: frontendTagId, name: "frontend" },
  ],
};

// Wednesday 2026-05-20; the model must resolve "Friday" to the NEXT Friday.
const now = new Date("2026-05-20T12:00:00.000Z");

function expectedNextFridayDateString(from: Date) {
  const date = new Date(from);
  const delta = (5 - date.getUTCDay() + 7) % 7 || 7; // Friday=5, strictly after `from`
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

describe("ai parse-task service", () => {
  let restoreEnv: (() => void) | undefined;
  let restoreFake: (() => void) | undefined;

  afterEach(() => {
    if (restoreFake) {
      restoreFake();
      restoreFake = undefined;
    }
    if (restoreEnv) {
      restoreEnv();
      restoreEnv = undefined;
    }
    vi.restoreAllMocks();
  });

  it("parses 'Fix login bug by Friday, high, @ada #backend' into a fully resolved draft", async () => {
    restoreEnv = stubFakeProviderEnv();
    const modelJson = {
      title: "Fix login bug",
      body: null,
      // Model resolved "Friday" against `now` and answered in plain date form.
      dueDate: "2026-05-22",
      priority: "high",
      assignee: "ada",
      tags: ["backend"],
      status: null,
    };
    const fake = installFakeFetch([
      jsonResponse({
        choices: [{
          message: { content: "```json\n" + JSON.stringify(modelJson, null, 2) + "\n```" },
          finish_reason: "stop",
        }],
      }),
    ]);
    restoreFake = fake.restore;

    const text = "Fix login bug by Friday, high, @ada #backend";
    const result = await parseTaskFromText(makeFakeProvider("openai_compatible"), {
      text,
      ...candidates,
      now,
    });

    expect(result.unresolved).toEqual([]);
    expect(result.draft).toEqual({
      title: "Fix login bug",
      dueDate: `${expectedNextFridayDateString(now)}T00:00:00.000Z`,
      priority: "high",
      assigneeId: adaId,
      tagIds: [backendTagId],
    });

    // Exactly one non-streaming completion; static system prompt with the
    // candidate lists + request text riding as data in the wrapped user turn.
    expect(fake.requests).toHaveLength(1);
    const body = fake.requests[0].body as {
      stream?: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.stream).toBeUndefined();
    expect(body.messages).toHaveLength(2);
    const [systemTurn, userTurn] = body.messages;
    expect(systemTurn.role).toBe("system");
    expect(systemTurn.content).toBe(PARSE_TASK_SYSTEM_PROMPT);
    // The system prompt stays static: no candidate data leaks into it.
    expect(systemTurn.content).not.toContain("ada@example.com");
    expect(systemTurn.content).not.toContain("backend");
    expect(userTurn.role).toBe("user");
    expect(userTurn.content).toContain("<taskito_context>");
    expect(userTurn.content).toContain("</taskito_context>");
    expect(userTurn.content).toContain("ada@example.com");
    expect(userTurn.content).toContain("backend");
    expect(userTurn.content).toContain("Todo");
    expect(userTurn.content).toContain(text);
    expect(userTurn.content).toContain(now.toISOString());
  });

  it("works over the anthropic adapter with the static prompt as the system field", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      jsonResponse({
        content: [{ type: "text", text: '{"title":"Fix login bug","priority":"high","assignee":"Ada Lovelace"}' }],
        stop_reason: "end_turn",
      }),
    ]);
    restoreFake = fake.restore;

    const result = await parseTaskFromText(makeFakeProvider("anthropic"), {
      text: "Fix login bug, high, assign Ada",
      ...candidates,
      now,
    });

    expect(result.draft).toEqual({
      title: "Fix login bug",
      priority: "high",
      assigneeId: adaId,
    });
    expect(fake.requests[0].url).toContain("/messages");
    const body = fake.requests[0].body as { system?: string; messages: Array<{ role: string }> };
    expect(body.system).toBe(PARSE_TASK_SYSTEM_PROMPT);
    expect(body.messages.every((message) => message.role !== "system")).toBe(true);
  });

  it("drops unresolvable references and lists them as unresolved — never guesses", async () => {
    restoreEnv = stubFakeProviderEnv();
    const fake = installFakeFetch([
      jsonResponse({
        choices: [{
          message: {
            content: JSON.stringify({
              title: "Fix login bug",
              body: "See the attached logs",
              dueDate: "someday",
              priority: "asap",
              assignee: "Mallory",
              tags: ["backend", "legacy"],
              status: "In Review",
            }),
          },
          finish_reason: "stop",
        }],
      }),
    ]);
    restoreFake = fake.restore;

    const result = await parseTaskFromText(makeFakeProvider("openai_compatible"), {
      text: "Fix login bug someday, asap, @mallory #backend #legacy in review",
      ...candidates,
      now,
    });

    // Only resolvable values survive: assignee "Mallory", tag "legacy",
    // priority "asap", date "someday" and status "Done" are all dropped.
    expect(result.draft).toEqual({
      title: "Fix login bug",
      body: "See the attached logs",
      tagIds: [backendTagId],
    });
    expect(result.unresolved).toEqual([
      'dueDate "someday" is not a valid date',
      'priority "asap" is not a valid priority',
      'assignee "Mallory" did not match any project member',
      'tag "legacy" did not match any project tag',
      'status "In Review" did not match any project status',
    ]);
    expect(JSON.stringify(result.draft)).not.toContain("mallory");
    expect(JSON.stringify(result.draft)).not.toContain(graceId);
    expect(JSON.stringify(result.draft)).not.toContain(statusTodoId);
  });

  it("raises the typed fixed-message error on malformed model output", async () => {
    restoreEnv = stubFakeProviderEnv();
    const modelSecret = "UPSTREAM-LEAKY-CONTENT-9f3b";
    const fake = installFakeFetch([
      jsonResponse({
        choices: [{ message: { content: `Sorry about ${modelSecret}, I cannot produce JSON.` }, finish_reason: "stop" }],
      }),
    ]);
    restoreFake = fake.restore;

    const error = await parseTaskFromText(makeFakeProvider("openai_compatible"), {
      text: "anything",
      ...candidates,
      now,
    }).then(
      () => {
        throw new Error("expected parseTaskFromText to reject");
      },
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(AiParseTaskError);
    expect((error as AiParseTaskError).message).toBe(
      "The AI response for quick-add could not be parsed. Try again or fill the form manually."
    );
    // The fixed message never embeds raw model output.
    expect((error as AiParseTaskError).message).not.toContain(modelSecret);
  });

  describe("extractJsonObjectLoose", () => {
    it("accepts fenced and prose-wrapped JSON objects", () => {
      expect(extractJsonObjectLoose('```json\n{"title":"A"}\n```')).toEqual({ title: "A" });
      expect(extractJsonObjectLoose('```\n{"title":"A"}\n```')).toEqual({ title: "A" });
      expect(extractJsonObjectLoose('Here you go:\n{"title":"A","tags":[]} hope that helps!')).toEqual({
        title: "A",
        tags: [],
      });
    });

    it("throws the typed error for non-JSON output and non-object JSON", () => {
      expect(() => extractJsonObjectLoose("no json here")).toThrow(AiParseTaskError);
      expect(() => extractJsonObjectLoose('```json\n["array"]\n```')).toThrow(AiParseTaskError);
      expect(() => extractJsonObjectLoose('{"truncated": ')).toThrow(AiParseTaskError);
    });
  });
});
