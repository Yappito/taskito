import type { Prisma } from "@prisma/client";

type PrismaClient = typeof import("@/lib/prisma").prisma;

/**
 * Tool-result loop persistence helpers.
 *
 * Outcome notes are persisted as `AiMessage` rows with `role: "tool"`,
 * `toolCallId` = the native provider tool-call id, `toolName` = the tool name,
 * and content = compact JSON outcome. On the next turn the orchestrator
 * replays them right after the assistant message that announced the call
 * (see AiToolMessage in @/lib/ai-types for the adapter mapping contract).
 */

export type AiToolOutcomeStatus = "executed" | "failed" | "rejected" | "rolled_back";

/** Tool rows longer than this get cut with a truncation marker. */
const MAX_TOOL_RESULT_CONTENT_LENGTH = 8000;

export function buildAiToolMessageContent(outcome: Record<string, unknown>) {
  const serialized = JSON.stringify(outcome);
  return serialized.length > MAX_TOOL_RESULT_CONTENT_LENGTH
    ? `${serialized.slice(0, MAX_TOOL_RESULT_CONTENT_LENGTH)}…[truncated]`
    : serialized;
}

export function getAiToolNameForActionType(actionType: string) {
  return `taskito_${actionType}`;
}

export function serializeAiActionExecutionOutcome(input: {
  status: AiToolOutcomeStatus;
  result?: unknown;
  errorMessage?: string | null;
}) {
  const outcome: Record<string, unknown> = { status: input.status };
  if (input.status === "executed" && input.result !== undefined) {
    outcome.result = input.result ?? null;
  }
  if (input.status === "failed") {
    outcome.error = input.errorMessage ?? "AI action execution failed";
  }
  if (input.status === "rejected") {
    outcome.reason = input.errorMessage;
  }
  return outcome;
}

export async function createAiToolResultMessage(
  prisma: PrismaClient,
  input: {
    conversationId: string;
    toolCallId: string | null;
    toolName: string;
    content: string;
  }
) {
  if (!input.toolCallId) {
    // No native tool-call id to pair with an assistant `toolCalls` entry;
    // markdown-fallback proposals and unknown providers cannot be answered.
    return null;
  }
  return prisma.aiMessage.create({
    data: {
      conversationId: input.conversationId,
      role: "tool",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      content: input.content,
    },
  });
}

export type AiToolResultMessageCreateInput = Prisma.AiMessageUncheckedCreateInput;