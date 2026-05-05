import { Prisma, type AiActionExecution } from "@prisma/client";

import { taskRouter } from "@/server/routers/task";
import { createCallerFactory } from "@/server/trpc";

import { resolveAiActionPayload } from "./tools";
import { captureAiCheckpointAfter, captureAiCheckpointBefore } from "./checkpoints";

const createCaller = createCallerFactory(taskRouter);

type PrismaClient = typeof import("@/lib/prisma").prisma;

function parseDate(value: unknown) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("AI action payload contains an invalid date");
  }
  return date;
}

function parseNullableDate(value: unknown) {
  if (value == null) {
    return null;
  }
  return parseDate(value);
}

export async function executeAiAction(
  prisma: PrismaClient,
  input: {
    actionExecution: Pick<AiActionExecution, "id" | "conversationId" | "actionType" | "projectId" | "taskId" | "proposedPayload">;
    requestedByUserId: string;
    selectedTaskIds?: string[];
  }
) {
  const caller = createCaller({
    prisma,
    session: {
      expires: new Date(Date.now() + 60_000).toISOString(),
      user: {
        id: input.requestedByUserId,
        role: "member",
        email: "",
        name: null,
        image: null,
      },
    },
  });

  const payload = await resolveAiActionPayload(prisma, input.actionExecution.projectId, input.actionExecution.actionType, input.actionExecution.proposedPayload, {
    selectedTaskIds: input.selectedTaskIds,
  });
  const checkpointBefore = await captureAiCheckpointBefore(prisma, {
    actionType: input.actionExecution.actionType,
    projectId: input.actionExecution.projectId,
    payload,
  });

  await prisma.aiActionExecution.update({
    where: { id: input.actionExecution.id },
    data: {
      checkpointBefore: checkpointBefore as unknown as Prisma.InputJsonValue,
      rollbackStatus: "unavailable",
      rollbackErrorMessage: null,
      rolledBackAt: null,
      rolledBackByUserId: null,
    },
  });

  let result: unknown;

  switch (input.actionExecution.actionType) {
    case "addComment":
      result = await caller.addComment({
        taskId: String(payload.taskId),
        content: String(payload.content),
      });
      break;
    case "addLink":
      result = await caller.addLink({
        sourceTaskId: String(payload.sourceTaskId),
        targetTaskId: String(payload.targetTaskId),
        linkType: payload.linkType as "blocks" | "relates" | "parent" | "child",
      });
      break;
    case "removeLink":
      result = await caller.removeLink({ id: String(payload.linkId) });
      break;
    case "moveStatus":
      result = await caller.update({
        id: String(payload.taskId),
        statusId: String(payload.statusId),
      });
      break;
    case "assignTask":
      result = await caller.update({
        id: String(payload.taskId),
        assigneeId: payload.assigneeId == null ? null : String(payload.assigneeId),
      });
      break;
    case "editTask":
      result = await caller.update({
        id: String(payload.taskId),
        ...(payload.title !== undefined ? { title: String(payload.title) } : {}),
        ...(payload.body !== undefined ? { body: payload.body == null ? null : String(payload.body) } : {}),
        ...(payload.priority !== undefined ? { priority: payload.priority as "none" | "low" | "medium" | "high" | "urgent" } : {}),
        ...(payload.dueDate !== undefined ? { dueDate: parseDate(payload.dueDate) } : {}),
        ...(payload.startDate !== undefined ? { startDate: parseNullableDate(payload.startDate) } : {}),
        ...(payload.tagIds !== undefined ? { tagIds: payload.tagIds as string[] } : {}),
        ...(payload.customFieldValues !== undefined ? { customFieldValues: payload.customFieldValues as Array<{ customFieldId: string; value: string | number | null }> } : {}),
      });
      break;
    case "bulkUpdate":
      result = await caller.bulkUpdate({
        projectId: input.actionExecution.projectId,
        taskIds: payload.taskIds as string[],
        ...(payload.statusId !== undefined ? { statusId: String(payload.statusId) } : {}),
        ...(payload.assigneeId !== undefined ? { assigneeId: payload.assigneeId == null ? null : String(payload.assigneeId) } : {}),
        ...(payload.addTagIds !== undefined ? { addTagIds: payload.addTagIds as string[] } : {}),
        ...(payload.removeTagIds !== undefined ? { removeTagIds: payload.removeTagIds as string[] } : {}),
        ...(payload.archive !== undefined ? { archive: Boolean(payload.archive) } : {}),
      });
      break;
    case "createTask": {
      result = await caller.create({
        projectId: input.actionExecution.projectId,
        title: String(payload.title),
        body: payload.body == null ? null : String(payload.body),
        priority: (payload.priority as "none" | "low" | "medium" | "high" | "urgent") ?? "none",
        dueDate: parseDate(payload.dueDate),
        ...(payload.startDate !== undefined ? { startDate: parseDate(payload.startDate) } : {}),
        ...(payload.statusId !== undefined ? { statusId: String(payload.statusId) } : {}),
        ...(payload.assigneeId !== undefined ? { assigneeId: payload.assigneeId == null ? null : String(payload.assigneeId) } : {}),
        ...(payload.tagIds !== undefined ? { tagIds: payload.tagIds as string[] } : {}),
        ...(payload.customFieldValues !== undefined ? { customFieldValues: payload.customFieldValues as Array<{ customFieldId: string; value: string | number | null }> } : {}),
      });

      break;
    }
    case "duplicateTask":
      result = await caller.duplicate({
        id: String(payload.taskId),
        ...(payload.title !== undefined ? { title: String(payload.title) } : {}),
      });
      break;
    case "archiveTask":
      result = await caller.archive({ id: String(payload.taskId) });
      break;
    case "unarchiveTask":
      result = await caller.unarchive({ id: String(payload.taskId) });
      break;
    default:
      throw new Error(`Unsupported AI action type: ${input.actionExecution.actionType}`);
  }

  const checkpointAfter = await captureAiCheckpointAfter(prisma, {
    actionType: input.actionExecution.actionType,
    projectId: input.actionExecution.projectId,
    payload,
    result,
    before: checkpointBefore,
  });
  const createdTaskId = checkpointAfter.createdTaskIds[0];

  await prisma.aiActionExecution.update({
    where: { id: input.actionExecution.id },
    data: {
      checkpointAfter: checkpointAfter as unknown as Prisma.InputJsonValue,
      rollbackStatus: "available",
      ...(createdTaskId ? { taskId: createdTaskId } : {}),
    },
  });

  return result;
}
