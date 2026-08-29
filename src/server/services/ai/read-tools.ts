import type { AiPermission } from "@/lib/ai-types";

import { requireProjectAccess } from "@/server/authz";

import { searchTasks } from "../task-search";
import { serializeAiTask } from "./context-builder";
import {
  isAiReadToolName,
  isAiReadToolPermitted,
  resolveTaskReference,
} from "./tools";

type PrismaClient = typeof import("@/lib/prisma").prisma;

/**
 * Server-side executors for the read-only AI tools (`taskito_search_tasks`,
 * `taskito_get_task`). These tools are never proposed: the orchestrator runs
 * them inside its bounded per-turn tool loop and feeds the compact JSON
 * results back to the provider as role:"tool" messages. Authz is never
 * bypassed — every call re-runs `requireProjectAccess` and only issues the
 * same project-scoped queries the routers use.
 */

export const MAX_SEARCH_QUERY_LENGTH = 200;
export const MAX_SEARCH_RESULTS = 20;
export const DEFAULT_SEARCH_RESULTS = 10;

export interface AiReadToolOutcome {
  toolCallId: string | null;
  name: string;
  /** Compact JSON outcome string persisted as the tool message content. */
  content: string;
}

function jsonOutcome(payload: Record<string, unknown>, maxLength = 8000) {
  const serialized = JSON.stringify(payload);
  return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}…[truncated]` : serialized;
}

function serializeSearchHit(hit: {
  id: string;
  projectKey: string;
  taskNumber: number;
  title: string;
  status?: { id?: string; name?: string } | null;
  priority: string;
  dueDate: string;
  description?: string | null;
  assignee?: { id?: string; name?: string | null } | null;
}) {
  return {
    id: hit.id,
    key: hit.projectKey ? `${hit.projectKey}-${hit.taskNumber}` : String(hit.taskNumber),
    title: hit.title,
    status: hit.status?.name ?? null,
    priority: hit.priority,
    dueDate: hit.dueDate,
    description: typeof hit.description === "string" && hit.description.length > 300
      ? `${hit.description.slice(0, 300)}…[truncated]`
      : hit.description ?? null,
    assignee: hit.assignee?.name ?? null,
  };
}

function parseSearchArguments(arguments_: Record<string, unknown>) {
  const query = typeof arguments_.query === "string" ? arguments_.query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH) : "";
  if (!query) {
    throw new Error("query must be a non-empty string");
  }
  const rawLimit = arguments_.limit;
  const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_SEARCH_RESULTS)
    : rawLimit instanceof String && Number.isInteger(Number(rawLimit)) && Number(rawLimit) > 0
      ? Math.min(Number(rawLimit), MAX_SEARCH_RESULTS)
      : DEFAULT_SEARCH_RESULTS;
  return { query, limit };
}

async function executeSearchTasks(prisma: PrismaClient, projectId: string, arguments_: Record<string, unknown>) {
  const { query, limit } = parseSearchArguments(arguments_);
  const result = await searchTasks(prisma, { query, projectId, limit });
  return {
    status: "ok",
    totalHits: result.totalHits,
    results: result.hits.map((hit) => serializeSearchHit(hit)),
  };
}

async function executeGetTask(prisma: PrismaClient, projectId: string, arguments_: Record<string, unknown>) {
  const reference = typeof arguments_.taskIdOrKey === "string" ? arguments_.taskIdOrKey.trim().slice(0, 100) : "";
  if (!reference) {
    throw new Error("taskIdOrKey must be a task id, task key like PROJECT-123, or exact task title");
  }
  const taskId = await resolveTaskReference(prisma, projectId, reference);
  const task = await prisma.task.findFirst({
    where: { id: taskId, projectId },
    include: {
      status: true,
      assignee: { select: { id: true, name: true, email: true, image: true } },
      creator: { select: { id: true, name: true, email: true, image: true } },
      tags: { include: { tag: true } },
      comments: {
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { author: { select: { id: true, name: true, image: true } } },
      },
      sourceLinks: {
        include: { targetTask: { select: { id: true, taskNumber: true, title: true, project: { select: { key: true } } } } },
      },
      targetLinks: {
        include: { sourceTask: { select: { id: true, taskNumber: true, title: true, project: { select: { key: true } } } } },
      },
      customFieldValues: { include: { customField: true } },
      project: { select: { key: true, slug: true } },
    },
  });
  if (!task) {
    throw new Error("Task was not found in this project");
  }
  return {
    status: "ok",
    task: serializeAiTask(task as unknown as Record<string, unknown>, { detailed: true }),
  };
}

/**
 * Executes read tool calls server-side. Each outcome becomes one compact
 * role:"tool" message (`{ toolCallId, name, content }`) in the orchestrator's
 * tool-result loop.
 */
export async function executeAiReadToolCalls(
  prisma: PrismaClient,
  input: {
    projectId: string;
    requestedByUserId: string;
    permissions: AiPermission[];
    calls: Array<{ id?: string; name: string; arguments: Record<string, unknown> }>;
  }
): Promise<AiReadToolOutcome[]> {
  return Promise.all(input.calls.map(async (call) => {
    const toolCallId = typeof call.id === "string" && call.id ? call.id : null;
    try {
      if (!isAiReadToolName(call.name) || !isAiReadToolPermitted(call.name, input.permissions)) {
        return {
          toolCallId,
          name: call.name,
          content: JSON.stringify({ status: "rejected", reason: "required read permission is not granted for this conversation" }),
        };
      }

      // Same project-scope guard as every AI router mutation.
      await requireProjectAccess(prisma, input.requestedByUserId, input.projectId);

      const result = call.name === "taskito_search_tasks"
        ? await executeSearchTasks(prisma, input.projectId, call.arguments ?? {})
        : await executeGetTask(prisma, input.projectId, call.arguments ?? {});
      return { toolCallId, name: call.name, content: jsonOutcome(result) };
    } catch (error) {
      return {
        toolCallId,
        name: call.name,
        content: JSON.stringify({
          status: "error",
          error: (error instanceof Error ? error.message : "read tool failed").slice(0, 300),
        }),
      };
    }
  }));
}