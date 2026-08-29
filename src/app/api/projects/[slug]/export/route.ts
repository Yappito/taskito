import { NextResponse } from "next/server";
import { TRPCError } from "@trpc/server";
import type { Session } from "next-auth";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bearerSessionFromIdentity, resolveBearerToken } from "@/server/services/api-tokens";
import { requireProjectAccess } from "@/server/authz";
import { buildTaskWhereFromDashboardQuery } from "@/server/services/dashboard-query";
import {
  buildExportRecord,
  exportHeaders,
  exportRecordToCells,
  EXPORT_BATCH_SIZE,
} from "@/server/services/task-transfer";
import { stringifyCsvRow } from "@/lib/csv";

export const dynamic = "force-dynamic";

const MAX_QUERY_LENGTH = 2000;

type ExportPrisma = typeof prisma;

/**
 * Builds the same query dictionary the dashboard uses so `query=` accepts the
 * JQL-like filter grammar (`status = Done AND priority in (high, urgent)`).
 */
async function getQueryDictionary(prisma: ExportPrisma, projectId: string, currentUserId: string) {
  const [statuses, tags, users, sprints] = await Promise.all([
    prisma.workflowStatus.findMany({
      where: { projectId },
      select: { id: true, name: true, category: true },
    }),
    prisma.tag.findMany({ where: { projectId }, select: { id: true, name: true } }),
    prisma.user.findMany({
      where: {
        disabledAt: null,
        OR: [
          { role: "admin" },
          { projectMemberships: { some: { projectId } } },
          { groupMemberships: { some: { group: { projectMemberships: { some: { projectId } } } } } },
        ],
      },
      select: { id: true, name: true, email: true },
    }),
    prisma.sprint.findMany({
      where: { projectId },
      select: { id: true, name: true, status: true },
    }),
  ]);

  return { currentUserId, statuses, tags, users, sprints };
}

function buildTaskInclude() {
  return {
    status: { select: { name: true } },
    project: { select: { key: true } },
    creator: { select: { email: true } },
    assignee: { select: { email: true } },
    sprint: { select: { name: true } },
    tags: { select: { tag: { select: { name: true } } } },
    participants: { select: { user: { select: { email: true } } }, orderBy: { createdAt: "asc" as const } },
    customFieldValues: { select: { value: true, customField: { select: { name: true } } } },
  };
}

/**
 * Streams tasks out of the project page by page (never buffering the whole
 * project) so large exports stay memory-friendly.
 */
async function* iterateExportTasks(prisma: ExportPrisma, where: Record<string, unknown>) {
  let cursor: string | undefined;
  const include = buildTaskInclude();

  for (;;) {
    const batch = await prisma.task.findMany({
      where: where as never,
      orderBy: { id: "asc" as const },
      take: EXPORT_BATCH_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include,
    });

    if (batch.length === 0) {
      return;
    }

    for (const task of batch) {
      yield task;
    }

    cursor = batch[batch.length - 1]!.id;
    if (batch.length < EXPORT_BATCH_SIZE) {
      return;
    }
  }
}

function errorResponse(error: unknown) {
  if (error instanceof TRPCError && error.code === "UNAUTHORIZED") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof TRPCError && (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")) {
    return NextResponse.json({ error: error.code === "NOT_FOUND" ? "Not found" : "Forbidden" }, { status: error.code === "NOT_FOUND" ? 404 : 403 });
  }
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

/** GET /api/projects/[slug]/export?format=csv|json&query=<dashboard-query> */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> }
) {
  let session: Session | null = await auth();
  if (!session?.user?.id) {
    // Personal API tokens: fall back to `Authorization: Bearer tk_…`
    const identity = await resolveBearerToken(prisma, request.headers);
    session = identity ? bearerSessionFromIdentity(identity) : null;
  }
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await context.params;
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "json" ? "json" : "csv";
  const query = (url.searchParams.get("query") ?? "").trim().slice(0, MAX_QUERY_LENGTH);

  const project = await prisma.project.findUnique({
    where: { slug },
    select: { id: true, key: true, name: true },
  });

  if (!project) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    // Export requires project access with task_read.
    await requireProjectAccess(prisma, session.user.id, project.id, { permission: "task_read" });

    const [customFields, dictionary] = await Promise.all([
      prisma.customField.findMany({
        where: { projectId: project.id },
        orderBy: [{ order: "asc" }, { name: "asc" }],
        select: { name: true },
      }),
      getQueryDictionary(prisma, project.id, session.user.id),
    ]);

    const archivedFilter = {
      OR: [{ archivedAt: null }, { archivedAt: { gt: new Date() } }],
    };
    let where: Record<string, unknown> = { AND: [{ projectId: project.id }, archivedFilter] };
    if (query) {
      const parsed = buildTaskWhereFromDashboardQuery(project.id, query, dictionary);
      where = parsed.where as Record<string, unknown>;
    }

    const customFieldNames = customFields.map((field) => field.name);
    const encoder = new TextEncoder();
    const dateStamp = new Date().toISOString().slice(0, 10);
    const filename = `taskito-${project.key}-${dateStamp}.${format}`;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          if (format === "csv") {
            // UTF-8 BOM so Excel detects the encoding, then the header row.
            controller.enqueue(encoder.encode("\uFEFF"));
            controller.enqueue(encoder.encode(stringifyCsvRow(exportHeaders(customFieldNames))));
          } else {
            controller.enqueue(encoder.encode("["));
          }

          let first = true;
          for await (const task of iterateExportTasks(prisma, where)) {
            const record = buildExportRecord(task, customFields);
            if (format === "csv") {
              controller.enqueue(encoder.encode(stringifyCsvRow(exportRecordToCells(record, customFieldNames))));
            } else {
              controller.enqueue(encoder.encode(`${first ? "" : ","}${JSON.stringify(record)}`));
            }
            first = false;
          }

          if (format === "json") {
            controller.enqueue(encoder.encode("]"));
          }
        } catch (error) {
          controller.error(error);
          return;
        }
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
