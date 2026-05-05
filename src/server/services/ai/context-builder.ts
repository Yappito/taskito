import { requireProjectAccess, requireTaskAccess } from "@/server/authz";
import type { AiConversationContextInput, AiConversationContextSnapshot } from "@/lib/ai-types";

type PrismaClient = typeof import("@/lib/prisma").prisma;
type AiContextRecord = Record<string, unknown>;
const PROJECT_TASK_CONTEXT_LIMIT = 50;

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
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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

function serializeTask(task: AiContextRecord, options: { detailed?: boolean } = {}) {
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
  input: AiConversationContextInput
): Promise<AiConversationContextSnapshot> {
  await requireProjectAccess(prisma, userId, input.projectId);

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
    prisma.projectMember.findMany({
      where: { projectId: input.projectId },
      orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }],
      select: {
        user: {
          select: { id: true, name: true, email: true, image: true },
        },
      },
    }).then((memberships) => memberships.map((membership) => membership.user)),
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
            tags: { include: { tag: true } },
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
        tags: { include: { tag: true } },
        project: { select: { key: true, slug: true } },
      },
      orderBy: [{ dueDate: "asc" }, { taskNumber: "asc" }],
      take: PROJECT_TASK_CONTEXT_LIMIT,
    }),
  ]);

  if (input.taskId) {
    await requireTaskAccess(prisma, userId, input.taskId);
  }

  return {
    project,
    currentTask: currentTask ? serializeTask(currentTask as unknown as AiContextRecord, { detailed: true }) : null,
    projectTasks: projectTasks.map((task) => serializeTask(task as unknown as AiContextRecord)),
    selectedTasks: selectedTasks.map((task) => serializeTask(task as unknown as AiContextRecord)),
    statuses,
    tags,
    people,
    customFields,
  };
}
