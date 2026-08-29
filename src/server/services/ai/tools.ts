import { z } from "zod";

import { normalizeAiPermissions } from "@/lib/ai-permissions";
import type {
  AiPermission,
  AiProposalDrop,
  AiProposalNormalizationResult,
  AiToolProposal,
} from "@/lib/ai-types";

type PrismaClient = typeof import("@/lib/prisma").prisma;

// Action types that are destructive enough to be excluded from automatic
// "yolo" execution unless the project policy explicitly allows it.
// Action-type names verified against the AiActionType enum in prisma/schema.prisma:
// archive_task & unarchive_task → archiveTask/unarchiveTask, bulk_update_selected → bulkUpdate,
// create_task → createTask, duplicate_task → duplicateTask, remove_link → removeLink.
export const YOLO_DESTRUCTIVE_ACTIONS: ReadonlySet<AiToolProposal["actionType"]> = new Set([
  "archiveTask",
  "unarchiveTask",
  "bulkUpdate",
  "createTask",
  "duplicateTask",
  "removeLink",
]);

const cuid = z.string().cuid();
const taskReference = z.string().trim().min(1).max(100);
const linkTypeInput = z.string().trim().min(1).max(50);
const priority = z.enum(["none", "low", "medium", "high", "urgent"]);
const dateString = z.string().trim().min(1).refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: "Date must be a valid ISO-compatible date string",
}).transform((value) => new Date(value).toISOString());
const nullableDateString = z.union([dateString, z.null()]);
const customFieldValueSchema = z.object({
  customFieldId: cuid,
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});
const customFieldValues = z.array(customFieldValueSchema).max(50);
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

export interface AiNativeToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AiNativeToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * OpenAI-compatible adapters MAY pass this through as `function.strict` for
   * structured outputs. Schemas here are `additionalProperties: false`, but full
   * OpenAI strict mode also requires every property to be listed in `required`
   * (with nullable types for optional inputs); adapters must reconcile that
   * before enabling structured outputs. Anthropic ignores this flag.
   */
  strict?: boolean;
}

const commonNativeToolFields = {
  title: { type: "string", description: "Short human-readable title for the proposed action." },
  summary: { type: "string", description: "One-sentence explanation of why this action should run." },
} satisfies Record<string, unknown>;

// Where tool argument values are allowed to come from. The model must never
// invent ids: every identifier must be read from the <taskito_context> JSON in
// the first user turn. Individual tool descriptions restate the relevant ones.
const ID_SOURCE_RULE = "IDs must come from the <taskito_context> JSON: task ids (or keys like PROJECT-123 where stated) from context.projectTasks/context.selectedTasks/context.currentTask, statusId from context.statuses[].id, assigneeId from context.people[].id, tagIds from context.tags[].id, customFieldId from context.customFields[].id.";
const CUSTOM_FIELD_VALUE_ITEM = {
  type: "object",
  properties: {
    customFieldId: { type: "string", description: "Custom field id from context.customFields[].id." },
    value: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }], description: "New value for the custom field; null clears it." },
  },
  required: ["customFieldId", "value"],
  additionalProperties: false,
} satisfies Record<string, unknown>;
const customFieldValuesItems = { type: "array", items: CUSTOM_FIELD_VALUE_ITEM, maxItems: 50 };

function toolDescription(actionType: string, rules: string) {
  return `Propose the Taskito ${actionType} action (requires user approval unless yolo mode is enabled by project policy). ${rules} ${ID_SOURCE_RULE}`;
}

const nativeToolDescriptions: Record<AiToolProposal["actionType"], string> = {
  addComment: "taskId must be a task id from the context; content is the comment text (1-5000 chars).",
  addLink: "sourceTaskId/targetTaskId may be task ids or keys like PROJECT-123 from the context; for dependencies use linkType blocks — the blocker is the source.",
  removeLink: "Remove a link with linkId from context.currentTask.links, or identify it with sourceTaskId, targetTaskId, and linkType.",
  moveStatus: "taskId must be a task id from the context; statusId must be one of context.statuses[].id.",
  assignTask: "assigneeId must be one of context.people[].id, or null to unassign.",
  editTask: "The top-level title argument is only the approval-card label; renaming REQUIREs the newTitle argument. Fields: body, priority, dueDate, startDate, tagIds, customFieldValues (customFieldId from context.customFields[], value string|number|boolean|null).",
  bulkUpdate: "taskIds must be a subset of the selected task ids provided in the context.",
  createTask: "taskTitle names the new task; dueDate (ISO date) is required — never infer it from unrelated tasks. Optional: body, priority, startDate, statusId (context.statuses[].id), assigneeId (context.people[].id), tagIds, customFieldValues (customFieldId from context.customFields[]).",
  duplicateTask: "taskId must be a task id from the context; newTitle optionally renames the duplicate.",
  archiveTask: "taskId must be a task id from the context.",
  unarchiveTask: "taskId must be a task id from the context.",
};

const nativeToolPayloadSchemas: Record<AiToolProposal["actionType"], Record<string, unknown>> = {
  addComment: {
    type: "object",
    required: ["title", "summary", "taskId", "content"],
    properties: { ...commonNativeToolFields, taskId: { type: "string", description: "Task id from the context (context.projectTasks/context.selectedTasks/context.currentTask)." }, content: { type: "string", description: "Comment text (1-5000 chars)." } },
    additionalProperties: false,
  },
  addLink: {
    type: "object",
    required: ["title", "summary", "sourceTaskId", "targetTaskId", "linkType"],
    properties: { ...commonNativeToolFields, sourceTaskId: { type: "string", description: "Task id or key like PROJECT-123 from the context (the blocker/parent/source)." }, targetTaskId: { type: "string", description: "Task id or key like PROJECT-123 from the context (the blocked/child/target)." }, linkType: { type: "string", enum: ["blocks", "relates", "parent", "child"], description: "One of: blocks, relates, parent, child." } },
    additionalProperties: false,
  },
  removeLink: {
    type: "object",
    required: ["title", "summary"],
    properties: { ...commonNativeToolFields, linkId: { type: "string", description: "Link id from context.currentTask.links, when present." }, sourceTaskId: { type: "string", description: "Task id or key like PROJECT-123; paired with targetTaskId + linkType when linkId is unknown." }, targetTaskId: { type: "string", description: "Task id or key like PROJECT-123." }, linkType: { type: "string", enum: ["blocks", "relates", "parent", "child"], description: "One of: blocks, relates, parent, child." } },
    additionalProperties: false,
  },
  moveStatus: {
    type: "object",
    required: ["title", "summary", "taskId", "statusId"],
    properties: { ...commonNativeToolFields, taskId: { type: "string", description: "Task id from the context." }, statusId: { type: "string", description: "Must be one of context.statuses[].id." } },
    additionalProperties: false,
  },
  assignTask: {
    type: "object",
    required: ["title", "summary", "taskId"],
    properties: { ...commonNativeToolFields, taskId: { type: "string", description: "Task id from the context." }, assigneeId: { anyOf: [{ type: "string" }, { type: "null" }], description: "User id from context.people[].id, or null to unassign." } },
    additionalProperties: false,
  },
  editTask: {
    type: "object",
    required: ["title", "summary", "taskId"],
    properties: { ...commonNativeToolFields, taskId: { type: "string", description: "Task id from the context." }, newTitle: { type: "string", description: "New task title when renaming. The top-level title argument is the proposal card label — renaming REQUIRES newTitle." }, body: { anyOf: [{ type: "string" }, { type: "null" }] }, priority: { type: "string", enum: ["none", "low", "medium", "high", "urgent"] }, dueDate: { type: "string" }, startDate: { anyOf: [{ type: "string" }, { type: "null" }] }, tagIds: { type: "array", items: { type: "string", description: "Tag id from context.tags[].id." } }, customFieldValues: customFieldValuesItems },
    additionalProperties: false,
  },
  bulkUpdate: {
    type: "object",
    required: ["title", "summary", "taskIds"],
    properties: { ...commonNativeToolFields, taskIds: { type: "array", items: { type: "string" }, maxItems: 100, description: "Task ids; must be a subset of the selected task ids in the context." }, statusId: { type: "string", description: "Must be one of context.statuses[].id." }, assigneeId: { anyOf: [{ type: "string" }, { type: "null" }], description: "User id from context.people[].id, or null to unassign." }, addTagIds: { type: "array", items: { type: "string", description: "Tag id from context.tags[].id." } }, removeTagIds: { type: "array", items: { type: "string", description: "Tag id from context.tags[].id." } }, archive: { type: "boolean" } },
    additionalProperties: false,
  },
  createTask: {
    type: "object",
    required: ["title", "summary", "taskTitle", "dueDate"],
    properties: { ...commonNativeToolFields, taskTitle: { type: "string", description: "Title of the new task." }, body: { anyOf: [{ type: "string" }, { type: "null" }] }, priority: { type: "string", enum: ["none", "low", "medium", "high", "urgent"] }, dueDate: { type: "string", description: "Required ISO-compatible date; every Taskito task needs a due date." }, startDate: { type: "string" }, statusId: { type: "string", description: "Optional; must be one of context.statuses[].id." }, assigneeId: { anyOf: [{ type: "string" }, { type: "null" }], description: "Optional; user id from context.people[].id." }, tagIds: { type: "array", items: { type: "string", description: "Tag id from context.tags[].id." } }, customFieldValues: customFieldValuesItems },
    additionalProperties: false,
  },
  duplicateTask: {
    type: "object",
    required: ["title", "summary", "taskId"],
    properties: { ...commonNativeToolFields, taskId: { type: "string", description: "Task id from the context." }, newTitle: { type: "string", description: "Optional title for the duplicate task." } },
    additionalProperties: false,
  },
  archiveTask: {
    type: "object",
    required: ["title", "summary", "taskId"],
    properties: { ...commonNativeToolFields, taskId: { type: "string", description: "Task id from the context." } },
    additionalProperties: false,
  },
  unarchiveTask: {
    type: "object",
    required: ["title", "summary", "taskId"],
    properties: { ...commonNativeToolFields, taskId: { type: "string", description: "Task id from the context." } },
    additionalProperties: false,
  },
};

/** Read tools are executed server-side by the orchestrator loop, not proposed. */
export const AI_READ_TOOL_NAMES = ["taskito_search_tasks", "taskito_get_task"] as const;
export type AiReadToolName = (typeof AI_READ_TOOL_NAMES)[number];

export function isAiReadToolName(name: string): name is AiReadToolName {
  return (AI_READ_TOOL_NAMES as readonly string[]).includes(name);
}

export function isAiReadToolPermitted(name: AiReadToolName, grantedPermissions: Iterable<AiPermission>): boolean {
  const granted = new Set(grantedPermissions);
  if (name === "taskito_search_tasks") {
    return granted.has("search_project");
  }
  // taskito_get_task may read a single task's details under any read permission.
  return granted.has("read_current_task") || granted.has("read_selected_tasks") || granted.has("search_project");
}

const readToolDefinitions: Record<AiReadToolName, AiNativeToolDefinition> = {
  taskito_search_tasks: {
    name: "taskito_search_tasks",
    description: "Search the current project's tasks by free text (titles, bodies, tag names, or a task key like PROJECT-123). Use when the context task list says truncated: true or a needed task is missing from the context. Results are a sample; totalHits may exceed the returned list.",
    strict: true,
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string", description: "Free-text search query (task title, body text, tag name, or task key like PROJECT-123)." },
        limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum number of results (capped at 20)." },
      },
      additionalProperties: false,
    },
  },
  taskito_get_task: {
    name: "taskito_get_task",
    description: "Fetch one task's full details by task id, task key (PROJECT-123), or exact unique task title within the current project. Use when the context is truncated or a field you need is marked truncated.",
    strict: true,
    inputSchema: {
      type: "object",
      required: ["taskIdOrKey"],
      properties: {
        taskIdOrKey: { type: "string", description: "Task id, task key like PROJECT-123, or exact unique task title." },
      },
      additionalProperties: false,
    },
  },
};

function normalizeNativeToolName(name: string): AiToolProposal["actionType"] | null {
  if (!name.startsWith("taskito_") || isAiReadToolName(name)) {
    return null;
  }
  const actionName = name.slice("taskito_".length) as AiToolProposal["actionType"];
  return actionPayloadSchemas[actionName] ? actionName : null;
}

export function buildAiToolDefinitions(permissions: unknown): AiNativeToolDefinition[] {
  const grantedPermissions = normalizeAiPermissions(permissions);
  const grantedSet = new Set(grantedPermissions);
  const writeTools = (Object.keys(nativeToolPayloadSchemas) as AiToolProposal["actionType"][])
    .filter((actionType) => {
      if (actionType === "editTask") {
        return grantedSet.has("edit_core_fields") || grantedSet.has("edit_tags") || grantedSet.has("edit_custom_fields");
      }
      return grantedSet.has(actionPermissionMap[actionType as Exclude<AiToolProposal["actionType"], "editTask">]);
    })
    .map((actionType) => ({
      name: `taskito_${actionType}` as const,
      description: toolDescription(actionType, nativeToolDescriptions[actionType]),
      strict: true as const,
      inputSchema: nativeToolPayloadSchemas[actionType],
    }));

  // Read-only tools are proposed nowhere: the orchestrator executes them
  // server-side inside its bounded tool loop, gated by the read permissions.
  const readTools = AI_READ_TOOL_NAMES.filter((name) => isAiReadToolPermitted(name, grantedSet))
    .map((name) => readToolDefinitions[name]);

  return [...readTools, ...writeTools];
}

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

export async function resolveTaskReference(prisma: PrismaClient, projectId: string, reference: string) {
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
  return normalizeAiToolProposalsDetailed(rawProposals, input).proposals;
}

function describeZodIssue(error: z.ZodError) {
  const issue = error.issues[0];
  if (!issue) {
    return "invalid payload";
  }
  const path = issue.path.length > 0 ? issue.path.join(".") : "payload";
  return `${path}: ${issue.message}`;
}

/**
 * Normalizes raw proposals (markdown fallback shape) and reports every dropped
 * candidate with a human-readable reason so the orchestrator can feed the model
 * a paired "rejected" tool result when the drop came from a native tool call.
 */
export function normalizeAiToolProposalsDetailed(
  rawProposals: unknown,
  input: {
    projectId: string;
    grantedPermissions: unknown;
    selectedTaskIds?: string[];
  }
): AiProposalNormalizationResult {
  const grantedPermissions = normalizeAiPermissions(input.grantedPermissions);
  const grantedSet = new Set(grantedPermissions);
  if (!Array.isArray(rawProposals)) {
    return { proposals: [], drops: [] };
  }

  const normalized: AiToolProposal[] = [];
  const drops: AiProposalDrop[] = [];
  for (const rawProposal of rawProposals) {
    // Native tool-call proposals carry their provider tool-call id alongside
    // the envelope (the zod schema strips it, so re-attach it manually).
    const rawToolCallId = typeof rawProposal === "object" && rawProposal !== null && typeof (rawProposal as Record<string, unknown>).toolCallId === "string"
      ? (rawProposal as Record<string, unknown>).toolCallId as string
      : undefined;
    const parsedProposal = proposalSchema.safeParse(rawProposal);
    if (!parsedProposal.success) {
      drops.push({
        ...(rawToolCallId ? { toolCallId: rawToolCallId } : {}),
        ...(typeof rawProposal === "object" && rawProposal !== null ? { name: `taskito_${String((rawProposal as Record<string, unknown>).actionType)}` } : {}),
        reason: `invalid proposal envelope — ${describeZodIssue(parsedProposal.error)}`,
      });
      continue;
    }

    const { data } = parsedProposal;
    let payload: Record<string, unknown>;
    try {
      payload = validateAiActionPayload(data.actionType, data.payload, {
        selectedTaskIds: input.selectedTaskIds,
      });
    } catch (error) {
      drops.push({
        ...(rawToolCallId ? { toolCallId: rawToolCallId } : {}),
        name: `taskito_${data.actionType}`,
        reason: error instanceof Error ? error.message : "invalid payload",
      });
      continue;
    }

    const requiredPermissions = getRequiredPermissionsForActionPayload(data.actionType, payload);
    const missing = requiredPermissions.filter((permission) => !grantedSet.has(permission));
    if (missing.length > 0) {
      drops.push({
        ...(rawToolCallId ? { toolCallId: rawToolCallId } : {}),
        name: `taskito_${data.actionType}`,
        reason: `missing permission ${missing.join(", ")}`,
      });
      continue;
    }

    normalized.push({
      ...(rawToolCallId ? { toolCallId: rawToolCallId } : {}),
      actionType: data.actionType,
      title: data.title,
      summary: data.summary,
      payload,
      projectId: input.projectId,
      taskId: data.taskId ?? getTaskIdFromPayload(data.actionType, payload),
    });
  }

  return { proposals: normalized, drops };
}

export function normalizeAiNativeToolCalls(
  nativeToolCalls: AiNativeToolCall[],
  input: {
    projectId: string;
    grantedPermissions: unknown;
    selectedTaskIds?: string[];
  }
) {
  return normalizeAiNativeToolCallsDetailed(nativeToolCalls, input).proposals;
}

/**
 * Normalizes native tool calls into proposals, attaching the provider tool-call
 * id to each proposal (for AiActionExecution.toolCallId) and reporting drops so
 * the orchestrator can write paired role:"tool" rejection rows.
 */
export function normalizeAiNativeToolCallsDetailed(
  nativeToolCalls: AiNativeToolCall[],
  input: {
    projectId: string;
    grantedPermissions: unknown;
    selectedTaskIds?: string[];
  }
): AiProposalNormalizationResult {
  const drops: AiProposalDrop[] = [];
  const proposalInputs = nativeToolCalls.flatMap((toolCall) => {
    const actionType = normalizeNativeToolName(toolCall.name);
    if (!actionType) {
      if (toolCall.id) {
        drops.push({
          toolCallId: toolCall.id,
          name: toolCall.name,
          reason: isAiReadToolName(toolCall.name)
            ? "read tools are not executed in this turn"
            : `unsupported tool "${toolCall.name}"`,
        });
      }
      return [];
    }

    const { title, summary, taskTitle, newTitle, ...payload } = toolCall.arguments;
    // For editTask the top-level `title` argument is consumed as the proposal's
    // human card label, so renames must come through the dedicated `newTitle`.
    const normalizedPayload: Record<string, unknown> = {
      ...payload,
      ...(actionType === "createTask" && typeof taskTitle === "string" ? { title: taskTitle } : {}),
      ...(actionType === "duplicateTask" && typeof newTitle === "string" ? { title: newTitle } : {}),
      ...(actionType === "editTask" && typeof newTitle === "string" && newTitle.trim() ? { title: newTitle.trim() } : {}),
    };

    return [{
      ...(toolCall.id ? { toolCallId: toolCall.id } : {}),
      actionType,
      title: typeof title === "string" && title.trim() ? title : `Propose ${actionType}`,
      summary: typeof summary === "string" && summary.trim() ? summary : `AI proposed ${actionType}.`,
      payload: normalizedPayload,
      taskId: typeof normalizedPayload.taskId === "string" ? normalizedPayload.taskId : undefined,
    }];
  });

  const { proposals, drops: normalizationDrops } = normalizeAiToolProposalsDetailed(proposalInputs, input);
  return { proposals, drops: [...drops, ...normalizationDrops] };
}
