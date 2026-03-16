import { MeiliSearch } from "meilisearch";

const MEILI_HOST = process.env.MEILI_URL ?? process.env.MEILISEARCH_URL ?? "http://localhost:7700";
const MEILI_KEY = process.env.MEILI_MASTER_KEY ?? process.env.MEILISEARCH_KEY;

/** Shared MeiliSearch client */
export const meili = new MeiliSearch({
  host: MEILI_HOST,
  apiKey: MEILI_KEY,
});

const TASKS_INDEX = "tasks";

/** Initialize MeiliSearch index with settings */
export async function initMeiliSearch(): Promise<void> {
  // Ensure the index exists with the correct primary key
  await meili.createIndex(TASKS_INDEX, { primaryKey: "id" }).catch(() => {
    // Index may already exist — that's fine
  });

  const index = meili.index(TASKS_INDEX);

  await index.updateSettings({
    searchableAttributes: ["title", "description", "tags", "comments"],
    filterableAttributes: ["projectId", "statusId", "priority", "dueDate", "tags"],
    sortableAttributes: ["dueDate", "createdAt", "title"],
    rankingRules: [
      "words",
      "typo",
      "proximity",
      "attribute",
      "sort",
      "exactness",
    ],
  });
}

interface MeiliTaskDocument {
  id: string;
  projectId: string;
  projectSlug: string;
  projectKey: string;
  taskNumber: number;
  title: string;
  description: string;
  statusId: string;
  priority: string;
  dueDate: string;
  createdAt: string;
  tags: string[];
  comments: string[];
}

function escapeFilterValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** Index a task document in MeiliSearch */
export async function indexTask(task: {
  id: string;
  projectId: string;
  title: string;
  description: unknown;
  body?: string | null;
  statusId: string;
  priority: string;
  dueDate: Date;
  createdAt: Date;
  tags?: Array<{ tag: { name: string } }>;
  comments?: Array<{ content: string }>;
  project?: { key: string; slug?: string };
  taskNumber?: number;
}): Promise<void> {
  const doc: MeiliTaskDocument = {
    id: task.id,
    projectId: task.projectId,
    projectSlug: task.project?.slug ?? "",
    projectKey: task.project?.key ?? "",
    taskNumber: task.taskNumber ?? 0,
    title: task.title,
    description: typeof task.description === "string" ? task.description : task.body ?? "",
    statusId: task.statusId,
    priority: task.priority,
    dueDate: task.dueDate.toISOString(),
    createdAt: task.createdAt.toISOString(),
    tags: task.tags?.map((t) => t.tag.name) ?? [],
    comments: task.comments?.map((c) => c.content) ?? [],
  };

  await meili.index(TASKS_INDEX).addDocuments([doc], { primaryKey: "id" });
}

/** Remove a task document from MeiliSearch */
export async function removeTaskFromIndex(taskId: string): Promise<void> {
  await meili.index(TASKS_INDEX).deleteDocument(taskId);
}

/** Search tasks via MeiliSearch */
export async function searchTasks(params: {
  query: string;
  projectIds: string[];
  statusIds?: string[];
  priorities?: string[];
  tagNames?: string[];
  offset?: number;
  limit?: number;
}): Promise<{
  hits: Array<MeiliTaskDocument & { _formatted?: Record<string, string> }>;
  totalHits: number;
  processingTimeMs: number;
  facetDistribution?: Record<string, Record<string, number>>;
}> {
  const filter: string[] = [];

  if (params.projectIds.length === 1) {
    filter.push(`projectId = "${escapeFilterValue(params.projectIds[0])}"`);
  } else if (params.projectIds.length > 1) {
    filter.push(
      `projectId IN [${params.projectIds
        .map((projectId) => `"${escapeFilterValue(projectId)}"`)
        .join(",")}]`
    );
  }
  if (params.statusIds?.length) {
    filter.push(
      `statusId IN [${params.statusIds
        .map((statusId) => `"${escapeFilterValue(statusId)}"`)
        .join(",")}]`
    );
  }
  if (params.priorities?.length) {
    filter.push(
      `priority IN [${params.priorities
        .map((priority) => `"${escapeFilterValue(priority)}"`)
        .join(",")}]`
    );
  }
  if (params.tagNames?.length) {
    for (const tag of params.tagNames) {
      filter.push(`tags = "${escapeFilterValue(tag)}"`);
    }
  }

  try {
    const result = await meili.index(TASKS_INDEX).search(params.query, {
      filter: filter.length > 0 ? filter : undefined,
      offset: params.offset ?? 0,
      limit: params.limit ?? 20,
      attributesToHighlight: ["title", "description"],
      highlightPreTag: "<mark>",
      highlightPostTag: "</mark>",
      facets: ["priority", "tags", "statusId"],
    });

    return {
      hits: result.hits as Array<MeiliTaskDocument & { _formatted?: Record<string, string> }>,
      totalHits: result.estimatedTotalHits ?? 0,
      processingTimeMs: result.processingTimeMs,
      facetDistribution: result.facetDistribution,
    };
  } catch (err: unknown) {
    const meiliErr = err as { code?: string };
    if (meiliErr.code === "index_not_found") {
      // Auto-initialize the index on first use
      await initMeiliSearch();
      return { hits: [], totalHits: 0, processingTimeMs: 0 };
    }
    throw err;
  }
}

/** Bulk index all tasks from Prisma */
export async function bulkSyncTasks(prisma: {
  task: {
    findMany: (args: {
      include: {
        tags: { include: { tag: true } };
        comments: true;
        project: { select: { key: true; slug: true } };
      };
    }) => Promise<Array<{
      id: string;
      projectId: string;
      taskNumber: number;
      title: string;
      description: unknown;
      body?: string | null;
      statusId: string;
      priority: string;
      dueDate: Date;
      createdAt: Date;
      tags: Array<{ tag: { name: string } }>;
      comments: Array<{ content: string }>;
      project: { key: string; slug: string };
    }>>;
  };
}): Promise<number> {
  const tasks = await prisma.task.findMany({
    include: {
      tags: { include: { tag: true } },
      comments: true,
      project: { select: { key: true, slug: true } },
    },
  });

  if (tasks.length === 0) return 0;

  const docs: MeiliTaskDocument[] = tasks.map((task) => ({
    id: task.id,
    projectId: task.projectId,
    projectSlug: task.project.slug,
    projectKey: task.project.key,
    taskNumber: task.taskNumber,
    title: task.title,
    description: typeof task.description === "string" ? task.description : task.body ?? "",
    statusId: task.statusId,
    priority: task.priority,
    dueDate: task.dueDate.toISOString(),
    createdAt: task.createdAt.toISOString(),
    tags: task.tags.map((t) => t.tag.name),
    comments: task.comments.map((c) => c.content),
  }));

  await meili.index(TASKS_INDEX).addDocuments(docs, { primaryKey: "id" });
  return docs.length;
}
