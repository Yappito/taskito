import type { AiConversation, AiMessage, Prisma } from "@prisma/client";

import { completeWithAnthropicProviderStructured } from "./provider-anthropic";
import { buildAiConversationContext } from "./context-builder";
import { executeAiAction } from "./action-executor";
import { completeWithOpenAiCompatibleProviderStructured, type AiProviderCompletion } from "./provider-openai-compatible";
import { buildAiContextMessage, buildAiSystemPrompt, extractAiProposals, stripAiProposalBlock } from "./presenter";
import { resolveAiProvider } from "./provider-registry";
import { buildAiToolDefinitions, normalizeAiNativeToolCalls, normalizeAiToolProposals, resolveAiActionPayload, type AiNativeToolDefinition } from "./tools";

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
        mode: input.conversation.mode,
        permissions: ((input.conversation.grantedPermissions ?? []) as string[]),
        currentDate: new Date().toISOString(),
      }),
      toolName: null,
      toolPayload: null,
      toolCalls: null,
      toolCallId: null,
      isStreaming: false,
      createdAt: new Date(0),
    },
    {
      id: "context",
      conversationId: input.conversation.id,
      role: "system",
      content: buildAiContextMessage(context),
      toolName: null,
      toolPayload: null,
      toolCalls: null,
      toolCallId: null,
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
  const assistantContent = stripAiProposalBlock(input.completion.content) || (proposals.length > 0 ? "I prepared the proposed action cards below." : "");

  const assistantMessage = await prisma.aiMessage.create({
    data: {
      conversationId: input.conversation.id,
      role: "assistant",
      content: assistantContent,
      ...(proposals.length ? { toolPayload: { proposals } as unknown as Prisma.InputJsonValue } : {}),
      ...(input.completion.toolCalls.length ? { toolCalls: input.completion.toolCalls as unknown as Prisma.InputJsonValue } : {}),
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
          status: input.conversation.mode === "yolo" ? "approved" : "proposed",
          proposedPayload: proposal.payload as Prisma.InputJsonValue,
        },
      })
    )
  );

  if (input.conversation.mode === "yolo") {
    // Execute sequentially in proposal order: parallel execution could interleave
    // checkpoints of independent actions and defeats per-action rollback safety.
    for (const execution of executions) {
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
        // Persisting the result failed after a successful execution: the
        // execution must not stay `approved` (it would look re-runnable).
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
