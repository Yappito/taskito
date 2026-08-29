import type { AiActionExecution, AiConversation, AiMessage, Prisma } from "@prisma/client";

import type { AiProposalDrop, AiToolProposal } from "@/lib/ai-types";

import { completeWithAnthropicProviderStructured, streamWithAnthropicProvider } from "./provider-anthropic";
import { buildAiConversationContext } from "./context-builder";
import { executeAiAction } from "./action-executor";
import { completeWithOpenAiCompatibleProviderStructured, streamWithOpenAiCompatibleProvider } from "./provider-openai-compatible";
import { appendAiTruncationNote, type AiProviderCompletion } from "./provider-request";
import { buildAiContextUserTurn, buildAiSystemPrompt, extractAiProposals, stripAiProposalBlock } from "./presenter";
import { executeAiReadToolCalls } from "./read-tools";
import { resolveAiProvider } from "./provider-registry";
import {
  createAiToolResultMessage,
  buildAiToolMessageContent,
  getAiToolNameForActionType,
  serializeAiActionExecutionOutcome,
} from "./tool-results";
import {
  isAiReadToolName,
  YOLO_DESTRUCTIVE_ACTIONS,
  buildAiToolDefinitions,
  normalizeAiNativeToolCallsDetailed,
  normalizeAiToolProposalsDetailed,
  resolveAiActionPayload,
  type AiNativeToolDefinition,
} from "./tools";
import { normalizeAiPermissions } from "@/lib/ai-permissions";

type PrismaClient = typeof import("@/lib/prisma").prisma;

async function completeWithProvider(provider: ReturnType<typeof resolveAiProvider>, messages: AiMessage[], tools?: AiNativeToolDefinition[]) {
  if (provider.adapter === "anthropic") {
    return completeWithAnthropicProviderStructured(provider, messages, tools);
  }

  return completeWithOpenAiCompatibleProviderStructured(provider, messages, tools);
}

type AiTurnConversation = Pick<AiConversation, "id" | "projectId" | "taskId" | "providerId" | "mode" | "grantedPermissions" | "selectedTaskIds">;

function toSyntheticMessageRow(row: {
  id: string;
  role: string;
  content: string;
  toolCallId?: string | null;
  toolName?: string | null;
  toolCalls?: unknown;
  usage?: unknown;
}, createdAt: Date): AiMessage {
  return {
    id: row.id,
    conversationId: "synthetic",
    role: row.role as AiMessage["role"],
    content: row.content,
    toolName: row.toolName ?? null,
    toolPayload: null,
    toolCalls: (row.toolCalls as Prisma.JsonValue | null) ?? null,
    toolCallId: row.toolCallId ?? null,
    usage: (row.usage as Prisma.JsonValue | null) ?? null,
    isStreaming: false,
    createdAt,
  };
}

export async function buildAiAssistantTurnRequest(
  prisma: PrismaClient,
  input: {
    conversation: AiTurnConversation;
    requestedByUserId: string;
  }
) {
  const providerRecord = await prisma.aiProviderConnection.findUniqueOrThrow({
    where: { id: input.conversation.providerId },
  });
  const provider = resolveAiProvider(providerRecord);
  const selectedTaskIds = Array.isArray(input.conversation.selectedTaskIds)
    ? (input.conversation.selectedTaskIds as string[])
    : undefined;
  const context = await buildAiConversationContext(prisma, input.requestedByUserId, {
    projectId: input.conversation.projectId,
    taskId: input.conversation.taskId ?? undefined,
    selectedTaskIds,
    permissions: input.conversation.grantedPermissions,
  });

  await prisma.aiConversation.update({
    where: { id: input.conversation.id },
    data: {
      contextSnapshot: context as unknown as Prisma.InputJsonValue,
      updatedAt: new Date(),
    },
  });

  const project = await prisma.project.findUniqueOrThrow({
    where: { id: input.conversation.projectId },
    select: { name: true },
  });

  const history = await prisma.aiMessage.findMany({
    where: { conversationId: input.conversation.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // Tool-result replay: every assistant message whose stored `toolCalls` JSON
  // announced a native call must be followed by its paired role:"tool" result
  // rows. Rows whose toolCallId was never announced (or has none) cannot be
  // paired to any provider turn and are dropped from the replay.
  const announcedToolCallIds = new Set<string>();
  const replayedHistory: AiMessage[] = [];
  for (const message of history) {
    if (message.role === "tool") {
      if (message.toolCallId && announcedToolCallIds.has(message.toolCallId)) {
        replayedHistory.push(message);
      }
      continue;
    }
    replayedHistory.push(message);
    if (message.role === "assistant" && Array.isArray(message.toolCalls)) {
      for (const call of message.toolCalls as Array<{ id?: unknown }>) {
        if (call && typeof call === "object" && typeof call.id === "string") {
          announcedToolCallIds.add(call.id);
        }
      }
    }
  }

  const syntheticMessages: AiMessage[] = [
    {
      id: "system-prompt",
      conversationId: input.conversation.id,
      role: "system",
      content: buildAiSystemPrompt({
        projectName: project.name,
      }),
      toolName: null,
      toolPayload: null,
      toolCalls: null,
      toolCallId: null,
      usage: null,
      isStreaming: false,
      createdAt: new Date(0),
    },
    {
      // The context snapshot is untrusted user data, so it is sent as a wrapped
      // first user turn — never as a system message and never unwrapped prose.
      id: "context",
      conversationId: input.conversation.id,
      role: "user",
      content: buildAiContextUserTurn({
        snapshot: context,
        generatedAt: new Date().toISOString(),
        mode: input.conversation.mode,
        permissions: ((input.conversation.grantedPermissions ?? []) as string[]),
      }),
      toolName: null,
      toolPayload: null,
      toolCalls: null,
      toolCallId: null,
      usage: null,
      isStreaming: false,
      createdAt: new Date(0),
    },
    ...replayedHistory,
  ];

  const tools = buildAiToolDefinitions(input.conversation.grantedPermissions);

  return {
    provider,
    syntheticMessages,
    selectedTaskIds,
    tools,
    toolsAvailable: tools.length > 0,
    readToolsAvailable: tools.some((tool) => isAiReadToolName(tool.name)),
  };
}

export async function persistAiAssistantCompletion(
  prisma: PrismaClient,
  input: {
    conversation: AiTurnConversation;
    requestedByUserId: string;
    completion: AiProviderCompletion;
    selectedTaskIds?: string[];
    /** Whether the turn had native tool definitions available (fallback gate). */
    toolsAvailable?: boolean;
    /** Drops produced outside normalization (e.g. read-tool round cap). */
    droppedBefore?: AiProposalDrop[];
  }
) {
  // The fenced-JSON fallback applies ONLY when the provider returned no native
  // tool calls AND the conversation had no native tools available for the turn.
  // When tools exist, model prose is never mined for proposals.
  const fallbackAllowed = input.completion.toolCalls.length === 0 && !(input.toolsAvailable ?? false);
  const fallback = fallbackAllowed
    ? normalizeAiToolProposalsDetailed(extractAiProposals(input.completion.content), {
        projectId: input.conversation.projectId,
        grantedPermissions: input.conversation.grantedPermissions,
        selectedTaskIds: input.selectedTaskIds,
      })
    : { proposals: [] as AiToolProposal[], drops: [] as AiProposalDrop[] };
  const native = normalizeAiNativeToolCallsDetailed(input.completion.toolCalls, {
    projectId: input.conversation.projectId,
    grantedPermissions: input.conversation.grantedPermissions,
    selectedTaskIds: input.selectedTaskIds,
  });
  const rawProposals = [...native.proposals, ...fallback.proposals];
  const seen = new Set<string>();
  const resolveDrops: AiProposalDrop[] = [];
  const proposals = (await Promise.all(rawProposals.map(async (proposal) => {
    const key = `${proposal.actionType}:${JSON.stringify(proposal.payload)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    try {
      const resolvedPayload = await resolveAiActionPayload(prisma, input.conversation.projectId, proposal.actionType, proposal.payload, { selectedTaskIds: input.selectedTaskIds });
      return { ...proposal, payload: resolvedPayload };
    } catch (error) {
      resolveDrops.push({
        ...(proposal.toolCallId ? { toolCallId: proposal.toolCallId } : {}),
        name: getAiToolNameForActionType(proposal.actionType),
        reason: error instanceof Error ? error.message : "invalid proposal payload",
      });
      return null;
    }
  }))).filter((proposal): proposal is (typeof rawProposals)[number] => proposal !== null);
  // Yolo scoping: destructive action types are only auto-approved when the
  // project policy explicitly allows it; otherwise they fall back to pending
  // approval cards like in approval mode.
  const policy = input.conversation.mode === "yolo"
    ? await prisma.aiProjectPolicy.findUnique({ where: { projectId: input.conversation.projectId } })
    : null;
  const allowYoloDestructive = policy?.allowYoloDestructive ?? false;

  const shouldAutoApprove = (actionType: string) =>
    input.conversation.mode === "yolo" &&
    !(YOLO_DESTRUCTIVE_ACTIONS.has(actionType as AiToolProposal["actionType"]) && !allowYoloDestructive);

  const pendingApprovalCount = input.conversation.mode === "yolo"
    ? proposals.filter((proposal) => !shouldAutoApprove(proposal.actionType)).length
    : 0;
  const builtContent = buildAssistantContent(input.completion.content, proposals, { pendingApprovalCount });
  // Truncated replies get a visible note so lost output is never silent.
  const assistantContent = input.completion.truncated ? appendAiTruncationNote(builtContent) : builtContent;

  const assistantMessage = await prisma.aiMessage.create({
    data: {
      conversationId: input.conversation.id,
      role: "assistant",
      content: assistantContent,
      ...(proposals.length ? { toolPayload: { proposals } as unknown as Prisma.InputJsonValue } : {}),
      ...(input.completion.toolCalls.length ? { toolCalls: input.completion.toolCalls as unknown as Prisma.InputJsonValue } : {}),
      ...(input.completion.usage ? { usage: input.completion.usage as unknown as Prisma.InputJsonValue } : {}),
    },
  });

  const executions = await Promise.all(
    proposals.map((proposal) =>
      prisma.aiActionExecution.create({
        data: {
          conversationId: input.conversation.id,
          messageId: assistantMessage.id,
          projectId: proposal.projectId,
          taskId: proposal.taskId ?? null,
          requestedByUserId: input.requestedByUserId,
          actionType: proposal.actionType,
          title: proposal.title,
          summary: proposal.summary,
          mode: input.conversation.mode,
          status: shouldAutoApprove(proposal.actionType) ? "approved" : "proposed",
          proposedPayload: proposal.payload as Prisma.InputJsonValue,
          ...(proposal.toolCallId ? { toolCallId: proposal.toolCallId } : {}),
        },
      })
    )
  );

  // Dropped proposals (validation, permissions, unsupported tools, round cap)
  // are answered with paired role:"tool" results so the model stops
  // re-proposing the same rejected change on the next turn. One tool row per
  // toolCallId: orchestrator-loop round-cap rejections win over the generic
  // normalization drops; markdown-fallback drops (no toolCallId) are skipped.
  const reportedDropIds = new Set<string>();
  const dedupedDrops = [...(input.droppedBefore ?? []), ...native.drops, ...fallback.drops, ...resolveDrops]
    .filter((drop) => {
      if (!drop.toolCallId || reportedDropIds.has(drop.toolCallId)) {
        return false;
      }
      reportedDropIds.add(drop.toolCallId);
      return true;
    });
  for (const drop of dedupedDrops) {
    if (!drop.toolCallId) {
      continue;
    }
    await createAiToolResultMessage(prisma, {
      conversationId: input.conversation.id,
      toolCallId: drop.toolCallId,
      toolName: drop.name ?? "taskito_unknown",
      content: buildAiToolMessageContent({ status: "rejected", reason: drop.reason }),
    });
  }

  if (input.conversation.mode === "yolo") {
    // Sequential in proposal order so each action's checkpointBefore is captured
    // after the previous action has fully written — parallel writes would corrupt
    // rollback checkpoints.
    for (const execution of executions) {
      if (execution.status !== "approved") {
        continue;
      }
      try {
        const result = await executeAiAction(prisma, {
          actionExecution: execution,
          requestedByUserId: input.requestedByUserId,
          selectedTaskIds: input.selectedTaskIds,
        });

        await prisma.aiActionExecution.update({
          where: { id: execution.id },
          data: {
            status: "executed",
            executedByUserId: input.requestedByUserId,
            executedPayload: execution.proposedPayload as Prisma.InputJsonValue,
            result: (result ?? null) as Prisma.InputJsonValue,
          },
        });

        await createAiToolResultMessage(prisma, {
          conversationId: input.conversation.id,
          toolCallId: execution.toolCallId ?? null,
          toolName: getAiToolNameForActionType(execution.actionType),
          content: buildAiToolMessageContent(serializeAiActionExecutionOutcome({ status: "executed", result: result ?? null })),
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "AI action execution failed";
        await prisma.aiActionExecution.update({
          where: { id: execution.id },
          data: {
            status: "failed",
            errorMessage,
          },
        });

        await createAiToolResultMessage(prisma, {
          conversationId: input.conversation.id,
          toolCallId: execution.toolCallId ?? null,
          toolName: getAiToolNameForActionType(execution.actionType),
          content: buildAiToolMessageContent(serializeAiActionExecutionOutcome({ status: "failed", errorMessage })),
        });
      }
    }
  }

  return { message: assistantMessage, proposals: executions, truncated: input.completion.truncated };
}

const AUTO_EXECUTED_FALLBACK_TEXT = "I prepared the proposed action cards below.";

function buildAssistantProposalNote(proposalCount: number) {
  const noun = proposalCount === 1 ? "action" : "actions";
  return `${proposalCount} ${noun} need${proposalCount === 1 ? "s" : ""} your approval.`;
}

export function buildAssistantContent(rawContent: string, proposals: Array<{ actionType: string }>, options: { pendingApprovalCount?: number } = {}) {
  const baseContent = stripAiProposalBlock(rawContent) || (proposals.length > 0 ? AUTO_EXECUTED_FALLBACK_TEXT : "");
  return options.pendingApprovalCount && options.pendingApprovalCount > 0
    ? `${baseContent}\n\n${buildAssistantProposalNote(options.pendingApprovalCount)}`
    : baseContent;
}

/** Maximum number of server-side read-tool rounds per user turn. */
export const MAX_AI_TOOL_ROUNDS_PER_TURN = 3;

export interface AiAssistantTurnResult {
  message: AiMessage;
  proposals: AiActionExecution[];
  readToolRounds: number;
  truncated: boolean;
}

/**
 * Runs a full AI user turn with the bounded read-tool loop: up to
 * {@link MAX_AI_TOOL_ROUNDS_PER_TURN} server-side read-tool rounds per turn.
 * Each round persists its assistant message (the one that announced the read
 * calls) and the paired role:"tool" results, so the next request replays
 * complete tool_use/tool_result pairs.
 */
export async function runAiAssistantTurn(
  prisma: PrismaClient,
  input: {
    conversation: AiTurnConversation;
    requestedByUserId: string;
    onDelta?: (delta: string) => void;
    signal?: AbortSignal;
  }
): Promise<AiAssistantTurnResult> {
  const request = await buildAiAssistantTurnRequest(prisma, input);
  const selectedTaskIds = request.selectedTaskIds;
  let messages = request.syntheticMessages;
  let readToolRounds = 0;
  const cappedReadDrops: AiProposalDrop[] = [];

  while (true) {
    const completion = input.onDelta
      ? (request.provider.adapter === "anthropic"
          ? await streamWithAnthropicProvider(request.provider, messages, request.tools, input.onDelta, input.signal)
          : await streamWithOpenAiCompatibleProvider(request.provider, messages, request.tools, input.onDelta, input.signal))
      : await completeWithProvider(request.provider, messages, request.tools);

    const writeToolCalls = completion.toolCalls.filter((call) => !isAiReadToolName(call.name));
    const readToolCalls = completion.toolCalls.filter((call) => isAiReadToolName(call.name));

    const shouldExecuteReadRound = request.readToolsAvailable
      && writeToolCalls.length === 0
      && readToolCalls.length > 0
      && readToolRounds < MAX_AI_TOOL_ROUNDS_PER_TURN;

    if (!shouldExecuteReadRound) {
      // Round cap reached for this turn: turn pending read calls into explicit
      // rejections so the model learns the loop is bounded.
      if (readToolCalls.length > 0) {
        for (const call of readToolCalls) {
          cappedReadDrops.push({
            ...(typeof call.id === "string" && call.id ? { toolCallId: call.id } : {}),
            name: call.name,
            reason: "tool round limit reached for this turn",
          });
        }
      }
      const persisted = await persistAiAssistantCompletion(prisma, {
        conversation: input.conversation,
        requestedByUserId: input.requestedByUserId,
        completion,
        selectedTaskIds,
        toolsAvailable: request.toolsAvailable,
        droppedBefore: cappedReadDrops,
      });
      return { message: persisted.message, proposals: persisted.proposals, readToolRounds, truncated: persisted.truncated };
    }

    readToolRounds += 1;
    const outcomes = await executeAiReadToolCalls(prisma, {
      projectId: input.conversation.projectId,
      requestedByUserId: input.requestedByUserId,
      permissions: normalizeAiPermissions(input.conversation.grantedPermissions),
      calls: readToolCalls,
    });

    // Persist the announcing assistant message so future turns can replay the
    // tool_use → tool_result pair against the provider.
    const assistantMessage = await prisma.aiMessage.create({
      data: {
        conversationId: input.conversation.id,
        role: "assistant",
        content: completion.content,
        ...(completion.toolCalls.length ? { toolCalls: completion.toolCalls as unknown as Prisma.InputJsonValue } : {}),
        ...(completion.usage ? { usage: completion.usage as unknown as Prisma.InputJsonValue } : {}),
      },
    });
    messages = [...messages, toSyntheticMessageRow(assistantMessage, new Date())];

    for (const outcome of outcomes) {
      const toolRow = await createAiToolResultMessage(prisma, {
        conversationId: input.conversation.id,
        toolCallId: outcome.toolCallId,
        toolName: outcome.name,
        content: outcome.content,
      });
      if (toolRow) {
        messages = [...messages, toSyntheticMessageRow(toolRow, new Date())];
      }
    }
  }
}

export async function appendAiAssistantTurn(
  prisma: PrismaClient,
  input: {
    conversation: Pick<AiConversation, "id" | "projectId" | "taskId" | "providerId" | "mode" | "grantedPermissions" | "selectedTaskIds">;
    requestedByUserId: string;
  }
) {
  const result = await runAiAssistantTurn(prisma, input);
  return { message: result.message, proposals: result.proposals };
}