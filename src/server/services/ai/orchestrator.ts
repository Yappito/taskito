import type { AiConversation, AiMessage, Prisma } from "@prisma/client";

import type { AiToolProposal } from "@/lib/ai-types";

import { completeWithAnthropicProviderStructured } from "./provider-anthropic";
import { buildAiConversationContext } from "./context-builder";
import { executeAiAction } from "./action-executor";
import { completeWithOpenAiCompatibleProviderStructured } from "./provider-openai-compatible";
import { appendAiTruncationNote, type AiProviderCompletion } from "./provider-request";
import { buildAiContextUserTurn, buildAiSystemPrompt, extractAiProposals, stripAiProposalBlock } from "./presenter";
import { resolveAiProvider } from "./provider-registry";
import { YOLO_DESTRUCTIVE_ACTIONS, buildAiToolDefinitions, normalizeAiNativeToolCalls, normalizeAiToolProposals, resolveAiActionPayload, type AiNativeToolDefinition } from "./tools";

type PrismaClient = typeof import("@/lib/prisma").prisma;

async function completeWithProvider(provider: ReturnType<typeof resolveAiProvider>, messages: AiMessage[], tools?: AiNativeToolDefinition[]) {
  if (provider.adapter === "anthropic") {
    return completeWithAnthropicProviderStructured(provider, messages, tools);
  }

  return completeWithOpenAiCompatibleProviderStructured(provider, messages, tools);
}

type AiTurnConversation = Pick<AiConversation, "id" | "projectId" | "taskId" | "providerId" | "mode" | "grantedPermissions" | "selectedTaskIds">;

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
    taskId: input.conversation.taskId,
    selectedTaskIds,
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
    orderBy: { createdAt: "asc" },
  });

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
    ...history,
  ];

  return {
    provider,
    syntheticMessages,
    selectedTaskIds,
    tools: buildAiToolDefinitions(input.conversation.grantedPermissions),
  };
}

export async function persistAiAssistantCompletion(
  prisma: PrismaClient,
  input: {
    conversation: AiTurnConversation;
    requestedByUserId: string;
    completion: AiProviderCompletion;
    selectedTaskIds?: string[];
  }
) {
  const markdownProposals = normalizeAiToolProposals(extractAiProposals(input.completion.content), {
    projectId: input.conversation.projectId,
    grantedPermissions: input.conversation.grantedPermissions,
    selectedTaskIds: input.selectedTaskIds,
  });
  const nativeProposals = normalizeAiNativeToolCalls(input.completion.toolCalls, {
    projectId: input.conversation.projectId,
    grantedPermissions: input.conversation.grantedPermissions,
    selectedTaskIds: input.selectedTaskIds,
  });
  const rawProposals = [...nativeProposals, ...markdownProposals];
  const seen = new Set<string>();
  const proposals = (await Promise.all(rawProposals.map(async (proposal) => {
    const key = `${proposal.actionType}:${JSON.stringify(proposal.payload)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    try {
      const resolvedPayload = await resolveAiActionPayload(prisma, input.conversation.projectId, proposal.actionType, proposal.payload, { selectedTaskIds: input.selectedTaskIds });
      return { ...proposal, payload: resolvedPayload };
    } catch {
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
        },
      })
    )
  );

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
      } catch (error) {
        await prisma.aiActionExecution.update({
          where: { id: execution.id },
          data: {
            status: "failed",
            errorMessage: error instanceof Error ? error.message : "AI action execution failed",
          },
        });
      }
    }
  }

  return { message: assistantMessage, proposals: executions };
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

export async function appendAiAssistantTurn(
  prisma: PrismaClient,
  input: {
    conversation: Pick<AiConversation, "id" | "projectId" | "taskId" | "providerId" | "mode" | "grantedPermissions" | "selectedTaskIds">;
    requestedByUserId: string;
  }
) {
  const request = await buildAiAssistantTurnRequest(prisma, input);
  const completion = await completeWithProvider(request.provider, request.syntheticMessages, request.tools);
  return persistAiAssistantCompletion(prisma, {
    conversation: input.conversation,
    requestedByUserId: input.requestedByUserId,
    completion,
    selectedTaskIds: request.selectedTaskIds,
  });
}
