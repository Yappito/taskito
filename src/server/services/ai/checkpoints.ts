import { Prisma, type AiActionExecution } from "@prisma/client";

type PrismaClient = typeof import("@/lib/prisma").prisma;
type AiActionType = AiActionExecution["actionType"];

type JsonRecord = Record<string, unknown>;

interface TaskSnapshot {
  id: string;
  exists: boolean;
  data?: JsonRecord;
  tagIds?: string[];
  customFieldValues?: Array<{ customFieldId: string; value: unknown }>;
}

interface LinkSnapshot {
  id: string;
  exists: boolean;
  sourceTaskId?: string;
  targetTaskId?: string;
  linkType?: string;
}

interface CommentSnapshot {
  id: string;
  exists: boolean;
  taskId?: string;
}

export interface AiActionCheckpoint {
  version: 1;
  actionType: AiActionType;
  projectId: string;
  capturedAt: string;
  tasks: TaskSnapshot[];
  links: LinkSnapshot[];
  comments: CommentSnapshot[];
  createdTaskIds: string[];
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
}

function asString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function unique(values: Array<string | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function toIso(value: Date | null) {
  return value ? value.toISOString() : null;
}

function toDate(value: unknown, fieldName: string) {
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Checkpoint contains an invalid ${fieldName}`);
  }
  return date;
}

function toNullableDate(value: unknown, fieldName: string) {
  return value == null ? null : toDate(value, fieldName);
}

function toInputJsonValue(value: unknown) {
  return value == null ? Prisma.JsonNull : value as Prisma.InputJsonValue;
}

function getObjectId(value: unknown) {
  const record = asRecord(value);
  return asString(record?.id);
}

function serializeTask(task: Awaited<ReturnType<typeof fetchTaskRows>>[number]): TaskSnapshot {
  return {
    id: task.id,
    exists: true,
    data: {
      projectId: task.projectId,
      taskNumber: task.taskNumber,
      creatorId: task.creatorId,
      assigneeId: task.assigneeId,
      title: task.title,
      description: task.description ?? null,
      body: task.body,
      statusId: task.statusId,
      priority: task.priority,
      dueDate: toIso(task.dueDate),
      startDate: toIso(task.startDate),
      closedAt: toIso(task.closedAt),
      archivedAt: toIso(task.archivedAt),
      alertAcknowledged: task.alertAcknowledged,
      createdAt: toIso(task.createdAt),
      updatedAt: toIso(task.updatedAt),
    },
    tagIds: task.tags.map((entry) => entry.tagId),
    customFieldValues: task.customFieldValues.map((entry) => ({
      customFieldId: entry.customFieldId,
      value: entry.value,
    })),
  };
}

async function fetchTaskRows(prisma: PrismaClient, ids: string[]) {
  if (ids.length === 0) {
    return [];
  }

  return prisma.task.findMany({
    where: { id: { in: ids } },
    include: {
      tags: { select: { tagId: true } },
      customFieldValues: { select: { customFieldId: true, value: true } },
    },
  });
}

async function captureTasks(prisma: PrismaClient, ids: string[]) {
  const normalizedIds = unique(ids);
  const tasks = await fetchTaskRows(prisma, normalizedIds);
  const taskById = new Map(tasks.map((task) => [task.id, serializeTask(task)]));

  return normalizedIds.map((id) => taskById.get(id) ?? { id, exists: false });
}

async function captureLinksByIds(prisma: PrismaClient, ids: string[]) {
  const normalizedIds = unique(ids);
  if (normalizedIds.length === 0) {
    return [] as LinkSnapshot[];
  }

  const links = await prisma.taskLink.findMany({
    where: { id: { in: normalizedIds } },
    select: { id: true, sourceTaskId: true, targetTaskId: true, linkType: true },
  });
  const linkById = new Map(links.map((link) => [link.id, { ...link, exists: true } satisfies LinkSnapshot]));
  return normalizedIds.map((id) => linkById.get(id) ?? { id, exists: false });
}

async function captureCommentsByIds(prisma: PrismaClient, ids: string[]) {
  const normalizedIds = unique(ids);
  if (normalizedIds.length === 0) {
    return [] as CommentSnapshot[];
  }

  const comments = await prisma.comment.findMany({
    where: { id: { in: normalizedIds } },
    select: { id: true, taskId: true },
  });
  const commentById = new Map(comments.map((comment) => [comment.id, { ...comment, exists: true } satisfies CommentSnapshot]));
  return normalizedIds.map((id) => commentById.get(id) ?? { id, exists: false });
}

async function findExistingLinkSnapshot(prisma: PrismaClient, payload: JsonRecord) {
  const sourceTaskId = asString(payload.sourceTaskId);
  const targetTaskId = asString(payload.targetTaskId);
  const linkType = asString(payload.linkType);
  if (!sourceTaskId || !targetTaskId || !linkType) {
    return [] as LinkSnapshot[];
  }

  const link = await prisma.taskLink.findFirst({
    where: { sourceTaskId, targetTaskId, linkType: linkType as "blocks" | "relates" | "parent" | "child" },
    select: { id: true, sourceTaskId: true, targetTaskId: true, linkType: true },
  });

  return link ? [{ ...link, exists: true }] : [];
}

function getBeforeTaskIds(actionType: AiActionType, payload: JsonRecord) {
  switch (actionType) {
    case "moveStatus":
    case "assignTask":
    case "editTask":
    case "archiveTask":
    case "unarchiveTask":
      return unique([asString(payload.taskId)]);
    case "bulkUpdate":
      return asStringArray(payload.taskIds);
    case "addComment":
    case "addLink":
    case "removeLink":
    case "createTask":
    case "duplicateTask":
      return [];
  }
}

function getAfterTaskIds(actionType: AiActionType, payload: JsonRecord, result: unknown, before: AiActionCheckpoint) {
  const resultId = getObjectId(result);
  switch (actionType) {
    case "createTask":
    case "duplicateTask":
      return unique([resultId]);
    case "removeLink":
      return before.tasks.map((task) => task.id);
    default:
      return getBeforeTaskIds(actionType, payload);
  }
}

function getCreatedTaskIds(actionType: AiActionType, result: unknown) {
  const resultId = getObjectId(result);
  return actionType === "createTask" || actionType === "duplicateTask" ? unique([resultId]) : [];
}

export async function captureAiCheckpointBefore(
  prisma: PrismaClient,
  input: { actionType: AiActionType; projectId: string; payload: JsonRecord }
): Promise<AiActionCheckpoint> {
  const links = input.actionType === "removeLink"
    ? await captureLinksByIds(prisma, unique([asString(input.payload.linkId)]))
    : input.actionType === "addLink"
      ? await findExistingLinkSnapshot(prisma, input.payload)
      : [];
  const taskIds = getBeforeTaskIds(input.actionType, input.payload);

  return {
    version: 1,
    actionType: input.actionType,
    projectId: input.projectId,
    capturedAt: new Date().toISOString(),
    tasks: await captureTasks(prisma, taskIds),
    links,
    comments: [],
    createdTaskIds: [],
  };
}

export async function captureAiCheckpointAfter(
  prisma: PrismaClient,
  input: { actionType: AiActionType; projectId: string; payload: JsonRecord; result: unknown; before: AiActionCheckpoint }
): Promise<AiActionCheckpoint> {
  const resultId = getObjectId(input.result);
  const linkIds = input.actionType === "addLink"
    ? unique([resultId])
    : input.actionType === "removeLink"
      ? input.before.links.map((link) => link.id)
      : [];
  const commentIds = input.actionType === "addComment" ? unique([resultId]) : [];

  return {
    version: 1,
    actionType: input.actionType,
    projectId: input.projectId,
    capturedAt: new Date().toISOString(),
    tasks: await captureTasks(prisma, getAfterTaskIds(input.actionType, input.payload, input.result, input.before)),
    links: await captureLinksByIds(prisma, linkIds),
    comments: await captureCommentsByIds(prisma, commentIds),
    createdTaskIds: getCreatedTaskIds(input.actionType, input.result),
  };
}

function parseCheckpoint(value: unknown) {
  const record = asRecord(value);
  if (!record || record.version !== 1) {
    throw new Error("AI action does not have a valid rollback checkpoint");
  }

  return record as unknown as AiActionCheckpoint;
}

function snapshotById<T extends { id: string }>(snapshots: T[]) {
  return new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
}

async function assertTaskUnchangedSinceCheckpoint(
  tx: Prisma.TransactionClient,
  taskId: string,
  afterTask: TaskSnapshot | undefined
) {
  if (!afterTask?.exists) {
    return;
  }

  const expectedUpdatedAt = asString(afterTask.data?.updatedAt);
  if (!expectedUpdatedAt) {
    return;
  }

  const current = await tx.task.findUnique({ where: { id: taskId }, select: { updatedAt: true } });
  if (!current) {
    throw new Error("Task changed after the AI action and cannot be rolled back safely");
  }

  if (current.updatedAt.toISOString() !== expectedUpdatedAt) {
    throw new Error("Task changed after the AI action and cannot be rolled back safely");
  }
}

async function deleteCreatedTasks(
  tx: Prisma.TransactionClient,
  before: AiActionCheckpoint,
  after: AiActionCheckpoint
) {
  const beforeTasks = snapshotById(before.tasks);
  const afterTasks = snapshotById(after.tasks);
  const createdTaskIds = unique([
    ...after.createdTaskIds,
    ...after.tasks.filter((task) => task.exists && !beforeTasks.has(task.id)).map((task) => task.id),
  ]);

  for (const taskId of createdTaskIds) {
    const current = await tx.task.findUnique({ where: { id: taskId }, select: { id: true, updatedAt: true } });
    if (!current) {
      continue;
    }

    const afterTask = afterTasks.get(taskId);
    const expectedUpdatedAt = asString(afterTask?.data?.updatedAt);
    if (expectedUpdatedAt && current.updatedAt.toISOString() !== expectedUpdatedAt) {
      throw new Error("AI-created task changed after creation and cannot be deleted safely");
    }

    await tx.task.delete({ where: { id: taskId } });
  }
}

async function restoreTaskSnapshot(
  tx: Prisma.TransactionClient,
  task: TaskSnapshot,
  afterTask: TaskSnapshot | undefined,
  input: { actorId: string; actionExecutionId: string }
) {
  if (!task.exists || !task.data) {
    return;
  }

  await assertTaskUnchangedSinceCheckpoint(tx, task.id, afterTask);

  await tx.task.update({
    where: { id: task.id },
    data: {
      creatorId: asString(task.data.creatorId) ?? null,
      assigneeId: asString(task.data.assigneeId) ?? null,
      title: String(task.data.title),
      description: toInputJsonValue(task.data.description),
      body: asString(task.data.body) ?? null,
      statusId: String(task.data.statusId),
      priority: task.data.priority as "none" | "low" | "medium" | "high" | "urgent",
      dueDate: toDate(task.data.dueDate, "dueDate"),
      startDate: toNullableDate(task.data.startDate, "startDate"),
      closedAt: toNullableDate(task.data.closedAt, "closedAt"),
      archivedAt: toNullableDate(task.data.archivedAt, "archivedAt"),
      alertAcknowledged: Boolean(task.data.alertAcknowledged),
    },
  });

  await tx.taskTag.deleteMany({ where: { taskId: task.id } });
  if (task.tagIds?.length) {
    await tx.taskTag.createMany({
      data: task.tagIds.map((tagId) => ({ taskId: task.id, tagId })),
      skipDuplicates: true,
    });
  }

  await tx.customFieldValue.deleteMany({ where: { taskId: task.id } });
  if (task.customFieldValues?.length) {
    await tx.customFieldValue.createMany({
      data: task.customFieldValues.map((entry) => ({
        taskId: task.id,
        customFieldId: entry.customFieldId,
        value: toInputJsonValue(entry.value),
      })),
      skipDuplicates: true,
    });
  }

  await tx.activityEvent.create({
    data: {
      taskId: task.id,
      actorId: input.actorId,
      action: "updated",
      details: {
        changedFields: ["aiRollback"],
        aiRollback: {
          source: "ai",
          actionExecutionId: input.actionExecutionId,
        },
      } as Prisma.InputJsonValue,
    },
  });
}

async function rollbackCreatedComments(tx: Prisma.TransactionClient, before: AiActionCheckpoint, after: AiActionCheckpoint) {
  const beforeCommentIds = new Set(before.comments.map((comment) => comment.id));
  const createdCommentIds = after.comments
    .filter((comment) => comment.exists && !beforeCommentIds.has(comment.id))
    .map((comment) => comment.id);

  if (createdCommentIds.length > 0) {
    await tx.comment.deleteMany({ where: { id: { in: createdCommentIds } } });
  }
}

async function rollbackLinks(tx: Prisma.TransactionClient, before: AiActionCheckpoint, after: AiActionCheckpoint) {
  const beforeLinkIds = new Set(before.links.map((link) => link.id));
  const createdLinkIds = after.links
    .filter((link) => link.exists && !beforeLinkIds.has(link.id))
    .map((link) => link.id);

  if (createdLinkIds.length > 0) {
    await tx.taskLink.deleteMany({ where: { id: { in: createdLinkIds } } });
  }

  for (const link of before.links) {
    if (!link.exists || !link.sourceTaskId || !link.targetTaskId || !link.linkType) {
      continue;
    }

    await tx.taskLink.upsert({
      where: { id: link.id },
      create: {
        id: link.id,
        sourceTaskId: link.sourceTaskId,
        targetTaskId: link.targetTaskId,
        linkType: link.linkType as "blocks" | "relates" | "parent" | "child",
      },
      update: {
        sourceTaskId: link.sourceTaskId,
        targetTaskId: link.targetTaskId,
        linkType: link.linkType as "blocks" | "relates" | "parent" | "child",
      },
    });
  }
}

export async function rollbackAiActionCheckpoint(
  prisma: PrismaClient,
  input: { execution: Pick<AiActionExecution, "id" | "checkpointBefore" | "checkpointAfter">; actorId: string }
) {
  const before = parseCheckpoint(input.execution.checkpointBefore);
  const after = parseCheckpoint(input.execution.checkpointAfter);
  const afterTasks = snapshotById(after.tasks);

  await prisma.$transaction(async (tx) => {
    await rollbackCreatedComments(tx, before, after);
    await rollbackLinks(tx, before, after);
    await deleteCreatedTasks(tx, before, after);

    for (const task of before.tasks) {
      await restoreTaskSnapshot(tx, task, afterTasks.get(task.id), {
        actorId: input.actorId,
        actionExecutionId: input.execution.id,
      });
    }
  });

  return { success: true };
}
