import type { AiConversation, AiMessage, Prisma } from "@prisma/client";

import { completeWithAnthropicProvider } from "./provider-anthropic";
import { buildAiConversationContext } from "./context-builder";
import { executeAiAction } from "./action-executor";
import { completeWithOpenAiCompatibleProvider } from "./provider-openai-compatible";
import { buildAiContextMessage, buildAiSystemPrompt, extractAiProposals, stripAiProposalBlock } from "./presenter";
import { resolveAiProvider } from "./provider-registry";
import { normalizeAiToolProposals, resolveAiActionPayload } from "./tools";

type PrismaClient = typeof import("@/lib/prisma").prisma;

async function completeWithProvider(provider: ReturnType<typeof resolveAiProvider>, messages: AiMessage[]) {
  if (provider.adapter === "anthropic") {
    return completeWithAnthropicProvider(provider, messages);
  }

  return completeWithOpenAiCompatibleProvider(provider, messages);
}

export async function appendAiAssistantTurn(
  prisma: PrismaClient,
  input: {
    conversation: Pick<AiConversation, "id" | "projectId" | "taskId" | "providerId" | "mode" | "grantedPermissions" | "selectedTaskIds">;
    requestedByUserId: string;
  }
) {
  const providerRecord = await prisma.aiProviderConnection.findUniqueOrThrow({
    where: { id: input.conversation.providerId },
  });
  const provider = resolveAiProvider(providerRecord);
  const context = await buildAiConversationContext(prisma, input.requestedByUserId, {
    projectId: input.conversation.projectId,
    taskId: input.conversation.taskId,
    selectedTaskIds: Array.isArray(input.conversation.selectedTaskIds)
      ? (input.conversation.selectedTaskIds as string[])
      : undefined,
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
      createdAt: new Date(0),
    },
    {
      id: "context",
      conversationId: input.conversation.id,
      role: "system",
      content: buildAiContextMessage(context),
      toolName: null,
      toolPayload: null,
      createdAt: new Date(0),
    },
    ...history,
  ];

  const completion = await completeWithProvider(provider, syntheticMessages);
  const selectedTaskIds = Array.isArray(input.conversation.selectedTaskIds)
    ? (input.conversation.selectedTaskIds as string[])
    : undefined;
  const rawProposals = normalizeAiToolProposals(extractAiProposals(completion), {
    projectId: input.conversation.projectId,
    grantedPermissions: input.conversation.grantedPermissions,
    selectedTaskIds,
  });
  const proposals = (await Promise.all(rawProposals.map(async (proposal) => {
    try {
      await resolveAiActionPayload(prisma, input.conversation.projectId, proposal.actionType, proposal.payload, { selectedTaskIds });
      return proposal;
    } catch {
      return null;
    }
  }))).filter((proposal): proposal is (typeof rawProposals)[number] => proposal !== null);
  const assistantContent = stripAiProposalBlock(completion);

  const assistantMessage = await prisma.aiMessage.create({
    data: {
      conversationId: input.conversation.id,
      role: "assistant",
      content: assistantContent,
      ...(proposals.length ? { toolPayload: { proposals } as unknown as Prisma.InputJsonValue } : {}),
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
    await Promise.all(
      executions.map(async (execution) => {
        try {
          const result = await executeAiAction(prisma, {
            actionExecution: execution,
            requestedByUserId: input.requestedByUserId,
            selectedTaskIds,
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
      })
    );
  }

  return {
    message: assistantMessage,
    proposals: executions,
  };
}
