import { requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { normalizeAiPermissions } from "@/lib/ai-permissions";
import type { AiConversationContextInput, AiConversationContextSnapshot } from "@/lib/ai-types";

type PrismaClient = typeof import("@/lib/prisma").prisma;
type AiContextRecord = Record<string, unknown>;
// Hard fetch cap so the char budget (not the DB) bounds the sample; the
// provider-visible trimming is done by AI_CONTEXT_MAX_CHARS below.
const PROJECT_TASK_CONTEXT_LIMIT = 200;
const CONTEXT_TASK_COMMENT_LIMIT = 5;
const DEFAULT_AI_CONTEXT_MAX_CHARS = 60_000;
const TRUNCATION_MARKER = "…[truncated]";

/**
 * Character budget for the serialized AI context snapshot. Read at call time
 * (not import time) so tests and deployments can tune it via env.
 */
export function getAiContextMaxChars() {
  const raw = process.env.AI_CONTEXT_MAX_CHARS?.trim();
  if (!raw) {
    return DEFAULT_AI_CONTEXT_MAX_CHARS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 200 ? parsed : DEFAULT_AI_CONTEXT_MAX_CHARS;
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AiContextRecord : null;
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function asDateLike(value: unknown) {
  return value instanceof Date || typeof value === "string" ? value : null;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : value;
}

function truncate(value: string | null | undefined, maxLength: number) {
  if (!value) {
    return value ?? null;
  }
  return value.length > maxLength ? `${value.slice(0, maxLength)}${TRUNCATION_MARKER}` : value;
}

function serializePerson(person: unknown) {
  const record = asRecord(person);
  if (!record) {
    return null;
  }
  return {
    id: record.id,
    name: record.name ?? null,
    email: record.email ?? null,
    image: record.image ?? null,
  };
}

function serializeLinkedTask(task: unknown) {
  const record = asRecord(task);
  const project = asRecord(record?.project);
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    key: project?.key ? `${project.key}-${record.taskNumber}` : String(record.taskNumber),
    title: record.title,
  };
}

/** Serializer shared by the context snapshot and the read tools (taskito_get_task). */
export function serializeAiTask(task: AiContextRecord, options: { detailed?: boolean } = {}) {
  const project = asRecord(task.project);
  const status = asRecord(task.status);
  return {
    id: task.id,
    key: project?.key ? `${project.key}-${task.taskNumber}` : String(task.taskNumber),
    taskNumber: task.taskNumber,
    title: task.title,
    body: truncate(asString(task.body), options.detailed ? 5000 : 700),
    priority: task.priority,
    dueDate: toIso(asDateLike(task.dueDate)),
    startDate: toIso(asDateLike(task.startDate)),
    closedAt: toIso(asDateLike(task.closedAt)),
    archivedAt: toIso(asDateLike(task.archivedAt)),
    status: status
      ? {
          id: status.id,
          name: status.name,
          category: status.category,
          isFinal: status.isFinal,
        }
      : null,
    assignee: serializePerson(task.assignee),
    creator: serializePerson(task.creator),
    tags: asArray(task.tags).map((entry) => {
      const tag = asRecord(asRecord(entry)?.tag);
      return { id: tag?.id, name: tag?.name, color: tag?.color };
    }),
    customFieldValues: asArray(task.customFieldValues).map((entry) => {
      const record = asRecord(entry);
      const customField = asRecord(record?.customField);
      return {
          customFieldId: record?.customFieldId,
          name: customField?.name ?? null,
          type: customField?.type ?? null,
          value: record?.value ?? null,
        };
    }),
    comments: options.detailed
      ? asArray(task.comments).map((comment) => {
          const record = asRecord(comment);
          return {
            id: record?.id,
            content: truncate(asString(record?.content), 1200),
            createdAt: toIso(asDateLike(record?.createdAt)),
            author: serializePerson(record?.author),
          };
        })
      : undefined,
    links: options.detailed
      ? {
            outgoing: asArray(task.sourceLinks).map((link) => {
              const record = asRecord(link);
              return {
                id: record?.id,
                type: record?.linkType,
                task: serializeLinkedTask(record?.targetTask),
              };
            }),
            incoming: asArray(task.targetLinks).map((link) => {
              const record = asRecord(link);
              return {
                id: record?.id,
                type: record?.linkType,
                task: serializeLinkedTask(record?.sourceTask),
              };
            }),
          }
      : undefined,
    recentActivity: options.detailed
      ? asArray(task.activityEvents).map((event) => {
          const record = asRecord(event);
          return {
            id: record?.id,
            action: record?.action,
            details: record?.details ?? null,
            createdAt: toIso(asDateLike(record?.createdAt)),
            actor: serializePerson(record?.actor),
          };
        })
      : undefined,
  };
}
export async function buildAiConversationContext(
  prisma: PrismaClient,
  userId: string,
  input: AiConversationContextInput & { permissions?: unknown }
): Promise<AiConversationContextSnapshot> {
  await requireProjectAccess(prisma, userId, input.projectId);

  // The three context sections are gated on the read permissions: a read_only
  // conversation sees task data, a no-permissions conversation must receive
  // none, so write-only proposals have nothing to read from.
  const permissions = normalizeAiPermissions(input.permissions);
  const canReadCurrentTask = permissions.includes("read_current_task");
  const canReadSelectedTasks = permissions.includes("read_selected_tasks");
  const canSearchProject = permissions.includes("search_project");

  const now = new Date();
  const activeTaskWhere = {
    projectId: input.projectId,
    OR: [{ archivedAt: null }, { archivedAt: { gt: now } }],
  };

  const [project, statuses, tags, customFields, people, currentTask, selectedTasks, projectTasks] = await Promise.all([
    prisma.project.findUniqueOrThrow({
      where: { id: input.projectId },
      select: { id: true, name: true, key: true, slug: true },
    }),
    prisma.workflowStatus.findMany({
      where: { projectId: input.projectId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, color: true, category: true, isFinal: true },
    }),
    prisma.tag.findMany({
      where: { projectId: input.projectId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
    prisma.customField.findMany({
      where: { projectId: input.projectId },
      orderBy: { order: "asc" },
      select: { id: true, name: true, type: true, required: true, options: true },
    }),
    prisma.user.findMany({
      where: {
        disabledAt: null,
        OR: [
          { role: "admin" },
          { projectMemberships: { some: { projectId: input.projectId } } },
          { groupMemberships: { some: { group: { projectMemberships: { some: { projectId: input.projectId } } } } } },
        ],
      },
      orderBy: [{ name: "asc" }, { email: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
      },
    }),
    input.taskId
      ? prisma.task.findUnique({
          where: { id: input.taskId },
          include: {
            status: true,
            creator: { select: { id: true, name: true, email: true, image: true } },
            assignee: { select: { id: true, name: true, email: true, image: true } },
            tags: { include: { tag: true } },
            comments: {
              orderBy: { createdAt: "desc" },
              take: 10,
              include: { author: { select: { id: true, name: true, image: true } } },
            },
            activityEvents: {
              orderBy: { createdAt: "desc" },
              take: 10,
              include: { actor: { select: { id: true, name: true, email: true, image: true } } },
            },
            sourceLinks: {
              include: {
                targetTask: {
                  select: { id: true, taskNumber: true, title: true, project: { select: { key: true } } },
                },
              },
            },
            targetLinks: {
              include: {
                sourceTask: {
                  select: { id: true, taskNumber: true, title: true, project: { select: { key: true } } },
                },
              },
            },
            customFieldValues: {
              include: { customField: true },
            },
            project: { select: { key: true, slug: true } },
          },
        })
      : Promise.resolve(null),
    input.selectedTaskIds?.length
      ? prisma.task.findMany({
          where: { id: { in: input.selectedTaskIds }, projectId: input.projectId },
          include: {
            status: true,
            assignee: { select: { id: true, name: true, email: true, image: true } },
            creator: { select: { id: true, name: true, email: true, image: true } },
            tags: { include: { tag: true } },
            comments: {
              orderBy: { createdAt: "desc" },
              take: CONTEXT_TASK_COMMENT_LIMIT,
              include: { author: { select: { id: true, name: true, email: true, image: true } } },
            },
            project: { select: { key: true, slug: true } },
          },
          orderBy: { dueDate: "asc" },
        })
      : Promise.resolve([]),
    prisma.task.findMany({
      where: activeTaskWhere,
      include: {
        status: true,
        assignee: { select: { id: true, name: true, email: true, image: true } },
        creator: { select: { id: true, name: true, email: true, image: true } },
        tags: { include: { tag: true } },
        comments: {
          orderBy: { createdAt: "desc" },
          take: CONTEXT_TASK_COMMENT_LIMIT,
          include: { author: { select: { id: true, name: true, email: true, image: true } } },
        },
        project: { select: { key: true, slug: true } },
      },
      // Most recently touched tasks first: the bounded sample then favors
      // whatever the project actually worked on.
      orderBy: [{ updatedAt: "desc" }, { taskNumber: "asc" }],
      take: PROJECT_TASK_CONTEXT_LIMIT,
    }),
  ]);

  if (input.taskId) {
    await requireTaskAccess(prisma, userId, input.taskId);
  }

  const serializedCurrentTask = canReadCurrentTask
    ? currentTask
      ? serializeAiTask(currentTask as unknown as AiContextRecord, { detailed: true })
      : null
    : null;
  const serializedSelectedTasks = canReadSelectedTasks
    ? selectedTasks.map((task) => serializeAiTask(task as unknown as AiContextRecord, { detailed: true }))
    : [];
  const serializedProjectTasks = canSearchProject
    ? projectTasks.map((task) => serializeAiTask(task as unknown as AiContextRecord, { detailed: true }))
    : [];

  const snapshot: AiConversationContextSnapshot = {
    project,
    currentTask: serializedCurrentTask,
    projectTasks: [],
    selectedTasks: serializedSelectedTasks,
    statuses,
    tags,
    people,
    customFields,
    truncated: false,
  };

  // Char budget: the compact JSON serialization of the snapshot (measured with
  // the worst-case `truncated: true` flag so the bound is pessimistic) must fit
  // inside AI_CONTEXT_MAX_CHARS. projectTasks are newest-first, so trimming
  // drops the stale tail first.
  const budget = getAiContextMaxChars();
  let truncated = canSearchProject && serializedProjectTasks.length >= PROJECT_TASK_CONTEXT_LIMIT;
  let runningLength = JSON.stringify({ ...snapshot, truncated: true }).length;
  const includedProjectTasks: Array<Record<string, unknown>> = [];
  for (const task of serializedProjectTasks) {
    const taskSize = JSON.stringify(task).length;
    if (includedProjectTasks.length > 0 && runningLength + taskSize > budget) {
      truncated = true;
      break;
    }
    includedProjectTasks.push(task);
    runningLength += taskSize;
  }
  // Exact pass: the incremental estimate skips join commas, so guarantee the
  // invariant by re-measuring and dropping the tail while over budget.
  while (includedProjectTasks.length > 0 && JSON.stringify({ ...snapshot, projectTasks: includedProjectTasks, truncated: true }).length > budget) {
    includedProjectTasks.pop();
    truncated = true;
  }
  if (JSON.stringify({ ...snapshot, projectTasks: includedProjectTasks, truncated: true }).length > budget) {
    // Nothing else can be dropped but the base snapshot alone exceeds the
    // budget; flag it so the model knows the view is incomplete.
    truncated = true;
  }

  snapshot.projectTasks = includedProjectTasks;
  snapshot.truncated = truncated;

  return snapshot;
}
