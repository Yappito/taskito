import { z } from "zod";

import { normalizeAiPermissions } from "@/lib/ai-permissions";
import type { AiPermission, AiToolProposal } from "@/lib/ai-types";

type PrismaClient = typeof import("@/lib/prisma").prisma;

const cuid = z.string().cuid();
const taskReference = z.string().trim().min(1).max(100);
const linkTypeInput = z.string().trim().min(1).max(50);
const priority = z.enum(["none", "low", "medium", "high", "urgent"]);
const dateString = z.string().trim().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: "Date must be a valid ISO-compatible date string",
}).transform((value) => new Date(value).toISOString());
const nullableDateString = z.union([dateString, z.null()]);
const customFieldValues = z.array(z.object({
  customFieldId: cuid,
  value: z.union([z.string(), z.number(), z.null()]),
})).max(50);
const taskKeyPattern = /^([a-z0-9]+)-(\d+)$/i;

const linkTaskPayload = z.object({
  sourceTaskId: taskReference,
  targetTaskId: taskReference,
  linkType: linkTypeInput,
});

const actionPermissionMap = {
  addComment: "add_comment",
  addLink: "link_tasks",
  removeLink: "link_tasks",
  moveStatus: "move_status",
  assignTask: "assign_task",
  bulkUpdate: "bulk_update_selected",
  createTask: "create_task",
  duplicateTask: "duplicate_task",
  archiveTask: "archive_task",
  unarchiveTask: "archive_task",
} as const satisfies Record<Exclude<AiToolProposal["actionType"], "editTask">, AiPermission>;

const actionPayloadSchemas = {
  addComment: z.object({
    taskId: cuid,
    content: z.string().trim().min(1).max(5000),
  }),
  addLink: linkTaskPayload,
  removeLink: z.union([
    z.object({ linkId: cuid }),
    linkTaskPayload,
  ]),
  moveStatus: z.object({
    taskId: cuid,
    statusId: cuid,
  }),
  assignTask: z.object({
    taskId: cuid,
    assigneeId: cuid.nullable(),
  }),
  editTask: z.object({
    taskId: cuid,
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(20000).nullable().optional(),
    priority: priority.optional(),
    dueDate: dateString.optional(),
    startDate: nullableDateString.optional(),
    tagIds: z.array(cuid).max(100).optional(),
    customFieldValues: customFieldValues.optional(),
  }).refine(
    (value) =>
      value.title !== undefined ||
      value.body !== undefined ||
      value.priority !== undefined ||
      value.dueDate !== undefined ||
      value.startDate !== undefined ||
      value.tagIds !== undefined ||
      value.customFieldValues !== undefined,
    { message: "Edit proposals must include at least one editable field" }
  ),
  bulkUpdate: z.object({
    taskIds: z.array(cuid).min(1).max(100),
    statusId: cuid.optional(),
    assigneeId: cuid.nullable().optional(),
    addTagIds: z.array(cuid).max(100).optional(),
    removeTagIds: z.array(cuid).max(100).optional(),
    archive: z.boolean().optional(),
  }).refine(
    (value) =>
      value.statusId !== undefined ||
      value.assigneeId !== undefined ||
      (value.addTagIds?.length ?? 0) > 0 ||
      (value.removeTagIds?.length ?? 0) > 0 ||
      value.archive !== undefined,
    { message: "Bulk update proposals must include at least one change" }
  ),
  createTask: z.object({
    title: z.string().trim().min(1).max(200),
    body: z.string().max(20000).nullable().optional(),
    priority: priority.default("none"),
    dueDate: dateString,
    startDate: dateString.optional(),
    statusId: cuid.optional(),
    assigneeId: cuid.nullable().optional(),
    tagIds: z.array(cuid).max(100).optional(),
    customFieldValues: customFieldValues.optional(),
  }),
  duplicateTask: z.object({
    taskId: cuid,
    title: z.string().trim().min(1).max(200).optional(),
  }),
  archiveTask: z.object({ taskId: cuid }),
  unarchiveTask: z.object({ taskId: cuid }),
} as const satisfies Record<AiToolProposal["actionType"], z.ZodTypeAny>;

const proposalSchema = z.object({
  actionType: z.enum([
    "addComment",
    "addLink",
    "removeLink",
    "moveStatus",
    "assignTask",
    "editTask",
    "bulkUpdate",
    "createTask",
    "duplicateTask",
    "archiveTask",
    "unarchiveTask",
  ]),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(2000),
  payload: z.record(z.string(), z.unknown()),
  taskId: cuid.optional(),
});

function getTaskIdFromPayload(actionType: AiToolProposal["actionType"], payload: Record<string, unknown>) {
  switch (actionType) {
    case "addComment":
    case "moveStatus":
    case "assignTask":
    case "editTask":
    case "duplicateTask":
    case "archiveTask":
    case "unarchiveTask":
      return typeof payload.taskId === "string" ? payload.taskId : undefined;
    default:
      return undefined;
  }
}

function assertBulkPayloadIsSelected(payload: Record<string, unknown>, selectedTaskIds: string[] | undefined) {
  if (!Array.isArray(payload.taskIds)) {
    return;
  }

  const selectedSet = new Set(selectedTaskIds ?? []);
  if (selectedSet.size === 0 || !payload.taskIds.every((taskId) => typeof taskId === "string" && selectedSet.has(taskId))) {
    throw new Error("Bulk AI actions may only target the selected tasks in the conversation");
  }
}

function normalizeLinkTypeValue(rawLinkType: string) {
  const normalized = rawLinkType.trim().toLowerCase().replace(/[\s-]+/g, "_");

  switch (normalized) {
    case "blocks":
    case "block":
      return { linkType: "blocks" as const, reverse: false };
    case "depends_on":
    case "blocked_by":
    case "is_blocked_by":
      return { linkType: "blocks" as const, reverse: true };
    case "relates":
    case "relates_to":
    case "related":
    case "related_to":
      return { linkType: "relates" as const, reverse: false };
    case "parent":
    case "parent_of":
    case "is_parent_of":
      return { linkType: "parent" as const, reverse: false };
    case "child":
    case "child_of":
    case "is_child_of":
      return { linkType: "child" as const, reverse: false };
    default:
      throw new Error(`Unsupported link type \"${rawLinkType}\". Use one of: blocks, relates, parent, child.`);
  }
}

function normalizeLinkPayload(payload: Record<string, unknown>) {
  const sourceTaskId = String(payload.sourceTaskId ?? "").trim();
  const targetTaskId = String(payload.targetTaskId ?? "").trim();
  const { linkType: normalizedLinkType, reverse } = normalizeLinkTypeValue(String(payload.linkType ?? ""));

  const normalizedPayload = {
    sourceTaskId: reverse ? targetTaskId : sourceTaskId,
    targetTaskId: reverse ? sourceTaskId : targetTaskId,
    linkType: normalizedLinkType,
  } satisfies Record<string, unknown>;

  if (normalizedPayload.sourceTaskId.trim().toLowerCase() === normalizedPayload.targetTaskId.trim().toLowerCase()) {
    throw new Error("A task cannot be linked to itself");
  }

  return normalizedPayload;
}

function formatTaskReference(reference: string) {
  const match = reference.trim().match(taskKeyPattern);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : reference.trim();
}

async function resolveTaskReference(prisma: PrismaClient, projectId: string, reference: string) {
  const trimmed = reference.trim();
  if (cuid.safeParse(trimmed).success) {
    return trimmed;
  }

  const match = trimmed.match(taskKeyPattern);
  if (!match) {
    const titleMatches = await prisma.task.findMany({
      where: {
        projectId,
        title: {
          equals: trimmed,
          mode: "insensitive",
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
      take: 2,
    });

    if (titleMatches.length === 1) {
      return titleMatches[0].id;
    }

    if (titleMatches.length > 1) {
      throw new Error(`Task reference \"${trimmed}\" matched multiple tasks in this project. Use a task key like PROJECT-123.`);
    }

    throw new Error(`Unsupported task reference \"${trimmed}\". Use a task id, exact task title, or task key like PROJECT-123.`);
  }

  const resolvedTask = await prisma.task.findFirst({
    where: {
      projectId,
      taskNumber: Number(match[2]),
      project: { key: match[1].toUpperCase() },
    },
    select: { id: true },
  });

  if (!resolvedTask) {
    throw new Error(`Task ${formatTaskReference(trimmed)} was not found in this project`);
  }

  return resolvedTask.id;
}

export function getRequiredPermissionForProposal(actionType: Exclude<AiToolProposal["actionType"], "editTask">) {
  return actionPermissionMap[actionType];
}

export function getRequiredPermissionsForActionPayload(actionType: AiToolProposal["actionType"], payload: Record<string, unknown>) {
  if (actionType !== "editTask") {
    return [actionPermissionMap[actionType as Exclude<AiToolProposal["actionType"], "editTask">]];
  }

  const required = new Set<AiPermission>();
  if (
    payload.title !== undefined ||
    payload.body !== undefined ||
    payload.priority !== undefined ||
    payload.dueDate !== undefined ||
    payload.startDate !== undefined
  ) {
    required.add("edit_core_fields");
  }
  if (payload.tagIds !== undefined) {
    required.add("edit_tags");
  }
  if (payload.customFieldValues !== undefined) {
    required.add("edit_custom_fields");
  }
  return [...required];
}

export function validateAiActionPayload(
  actionType: AiToolProposal["actionType"],
  payload: unknown,
  options: { selectedTaskIds?: string[] } = {}
) {
  let parsed = actionPayloadSchemas[actionType].parse(payload) as Record<string, unknown>;
  if (actionType === "addLink") {
    parsed = normalizeLinkPayload(parsed);
  }
  if (actionType === "removeLink" && typeof parsed.linkId !== "string") {
    parsed = normalizeLinkPayload(parsed);
  }
  if (actionType === "bulkUpdate") {
    assertBulkPayloadIsSelected(parsed, options.selectedTaskIds);
  }
  return parsed;
}

export async function resolveAiActionPayload(
  prisma: PrismaClient,
  projectId: string,
  actionType: AiToolProposal["actionType"],
  payload: unknown,
  options: { selectedTaskIds?: string[] } = {}
) {
  const parsed = validateAiActionPayload(actionType, payload, options);

  if (actionType === "addLink") {
    const sourceTaskId = await resolveTaskReference(prisma, projectId, String(parsed.sourceTaskId));
    const targetTaskId = await resolveTaskReference(prisma, projectId, String(parsed.targetTaskId));

    if (sourceTaskId === targetTaskId) {
      throw new Error("A task cannot be linked to itself");
    }

    return {
      ...parsed,
      sourceTaskId,
      targetTaskId,
    };
  }

  if (actionType === "removeLink") {
    if (typeof parsed.linkId === "string") {
      return parsed;
    }

    const sourceTaskId = await resolveTaskReference(prisma, projectId, String(parsed.sourceTaskId));
    const targetTaskId = await resolveTaskReference(prisma, projectId, String(parsed.targetTaskId));

    if (sourceTaskId === targetTaskId) {
      throw new Error("A task cannot be linked to itself");
    }

    const existingLink = await prisma.taskLink.findFirst({
      where: {
        sourceTaskId,
        targetTaskId,
        linkType: parsed.linkType as "blocks" | "relates" | "parent" | "child",
      },
      select: { id: true },
    });

    if (!existingLink) {
      throw new Error(
        `Link ${formatTaskReference(String(parsed.sourceTaskId))} -> ${formatTaskReference(String(parsed.targetTaskId))} (${String(parsed.linkType)}) was not found`
      );
    }

    return {
      ...parsed,
      linkId: existingLink.id,
      sourceTaskId,
      targetTaskId,
    };
  }

  return parsed;
}

export function normalizeAiToolProposals(
  rawProposals: unknown,
  input: {
    projectId: string;
    grantedPermissions: unknown;
    selectedTaskIds?: string[];
  }
): AiToolProposal[] {
  const grantedPermissions = normalizeAiPermissions(input.grantedPermissions);
  const grantedSet = new Set(grantedPermissions);
  if (!Array.isArray(rawProposals)) {
    return [] as AiToolProposal[];
  }

  const normalized: AiToolProposal[] = [];
  for (const rawProposal of rawProposals) {
    const parsedProposal = proposalSchema.safeParse(rawProposal);
    if (!parsedProposal.success) {
      continue;
    }

    const { data } = parsedProposal;
    let payload: Record<string, unknown>;
    try {
      payload = validateAiActionPayload(data.actionType, data.payload, {
        selectedTaskIds: input.selectedTaskIds,
      });
    } catch {
      continue;
    }

    const requiredPermissions = getRequiredPermissionsForActionPayload(data.actionType, payload);
    if (!requiredPermissions.every((permission) => grantedSet.has(permission))) {
      continue;
    }

    normalized.push({
      actionType: data.actionType,
      title: data.title,
      summary: data.summary,
      payload,
      projectId: input.projectId,
      taskId: data.taskId ?? getTaskIdFromPayload(data.actionType, payload),
    });
  }

  return normalized;
}
