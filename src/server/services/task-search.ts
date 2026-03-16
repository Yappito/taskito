import { Prisma, type TaskPriority } from "@prisma/client";

interface SearchTaskHit {
  id: string;
  projectId: string;
  projectSlug: string;
  projectKey: string;
  taskNumber: number;
  title: string;
  description: string;
  status: {
    id: string;
    name: string;
    color: string;
  };
  priority: string;
  dueDate: string;
  createdAt: string;
  tags: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  assignee: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  comments: string[];
  _formatted?: Record<string, string>;
}

interface SearchTaskResult {
  hits: SearchTaskHit[];
  totalHits: number;
  processingTimeMs: number;
  facetDistribution?: Record<string, Record<string, number>>;
}

type SearchPrismaClient = typeof import("@/lib/prisma").prisma;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightMatch(value: string, query: string) {
  if (!value || !query.trim()) {
    return value;
  }

  const matcher = new RegExp(`(${escapeRegExp(query.trim())})`, "ig");
  return value.replace(matcher, "<mark>$1</mark>");
}

export async function searchTasks(
  prisma: SearchPrismaClient,
  params: {
    query: string;
    projectId: string;
    statusIds?: string[];
    priorities?: string[];
    tagNames?: string[];
    offset?: number;
    limit?: number;
  }
): Promise<SearchTaskResult> {
  const startedAt = Date.now();
  const query = params.query.trim();
  const issueKeyMatch = query.match(/^([a-z0-9]+)-(\d+)$/i);
  const keyFilter = issueKeyMatch
    ? {
        taskNumber: Number(issueKeyMatch[2]),
        project: { key: issueKeyMatch[1].toUpperCase() },
      }
    : null;

  const where: Prisma.TaskWhereInput = {
    projectId: params.projectId,
    ...(params.statusIds?.length ? { statusId: { in: params.statusIds } } : {}),
    ...(params.priorities?.length ? { priority: { in: params.priorities as TaskPriority[] } } : {}),
    ...(params.tagNames?.length
      ? {
          AND: params.tagNames.map((tagName) => ({
            tags: { some: { tag: { name: tagName } } },
          })),
        }
      : {}),
    ...(query
      ? {
          OR: [
            { title: { contains: query, mode: "insensitive" } },
            { body: { contains: query, mode: "insensitive" } },
            { tags: { some: { tag: { name: { contains: query, mode: "insensitive" } } } } },
            ...(keyFilter ? [keyFilter] : []),
          ],
        }
      : {}),
  };

  const [totalHits, tasks] = await Promise.all([
    prisma.task.count({ where }),
    prisma.task.findMany({
      where,
      include: {
        status: { select: { id: true, name: true, color: true } },
        tags: { include: { tag: true } },
        assignee: { select: { id: true, name: true, email: true } },
        project: { select: { key: true, slug: true } },
      },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
      skip: params.offset ?? 0,
      take: params.limit ?? 20,
    }),
  ]);

  const hits: SearchTaskHit[] = tasks.map((task) => {
    const description = typeof task.description === "string" ? task.description : task.body ?? "";
    return {
      id: task.id,
      projectId: task.projectId,
      projectSlug: task.project.slug,
      projectKey: task.project.key,
      taskNumber: task.taskNumber,
      title: task.title,
      description,
      status: task.status,
      priority: task.priority,
      dueDate: task.dueDate.toISOString(),
      createdAt: task.createdAt.toISOString(),
      tags: task.tags.map((entry) => ({
        id: entry.tag.id,
        name: entry.tag.name,
        color: entry.tag.color,
      })),
      assignee: task.assignee,
      comments: [],
      _formatted: {
        title: highlightMatch(task.title, query),
        description: highlightMatch(description, query),
      },
    };
  });

  return {
    hits,
    totalHits,
    processingTimeMs: Date.now() - startedAt,
  };
}