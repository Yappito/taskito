import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { createTRPCRouter, protectedProcedure, type TRPCContext } from "@/server/trpc";
import { getEffectiveProjectAccess, requireProjectAccess } from "@/server/authz";
import { buildTaskWhereFromDashboardQuery, dashboardQueryHelp, type DashboardQueryDictionary } from "@/server/services/dashboard-query";
import { computeBurndownDays } from "@/server/services/burndown";

const visibilitySchema = z.enum(["public", "restricted"]);
const widgetTypeSchema = z.enum(["metric", "pie", "bar", "table", "burndown"]);
const groupBySchema = z.enum(["status", "priority", "assignee", "tag", "sprint", "dueMonth"]);
const metricSchema = z.enum(["count", "overdue", "completed", "unassigned"]);

const shareUserIdsSchema = z.array(z.string().cuid()).default([]);

const dashboardSelect = {
  id: true,
  projectId: true,
  ownerId: true,
  name: true,
  description: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true, email: true, image: true } },
  shares: {
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: "asc" as const },
  },
  widgets: {
    orderBy: [{ order: "asc" as const }, { createdAt: "asc" as const }],
    include: {
      savedFilter: {
        select: {
          id: true,
          name: true,
          visibility: true,
          ownerId: true,
          shares: { select: { userId: true } },
        },
      },
    },
  },
} satisfies Prisma.DashboardSelect;

const savedFilterSelect = {
  id: true,
  projectId: true,
  ownerId: true,
  name: true,
  description: true,
  query: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  owner: { select: { id: true, name: true, email: true, image: true } },
  shares: {
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: "asc" as const },
  },
} satisfies Prisma.SavedFilterSelect;

type DashboardForView = Prisma.DashboardGetPayload<{ select: typeof dashboardSelect }>;

function visibleToUser(resource: { visibility: string; ownerId: string; shares: Array<{ userId: string }> }, userId: string) {
  return resource.visibility === "public" || resource.ownerId === userId || resource.shares.some((share) => share.userId === userId);
}

function visibilityWhere(userId: string) {
  return {
    OR: [
      { visibility: "public" as const },
      { ownerId: userId },
      { shares: { some: { userId } } },
    ],
  };
}

async function assertProjectShareUsers(ctx: TRPCContext, projectId: string, userIds: string[], ownerId: string) {
  const uniqueIds = [...new Set(userIds)].filter((id) => id !== ownerId);
  if (uniqueIds.length === 0) return [];

  const users = await ctx.prisma.user.findMany({
    where: {
      id: { in: uniqueIds },
      disabledAt: null,
      OR: [
        { role: "admin" },
        { projectMemberships: { some: { projectId } } },
        { groupMemberships: { some: { group: { projectMemberships: { some: { projectId } } } } } },
      ],
    },
    select: { id: true },
  });

  if (users.length !== uniqueIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "All shared users must be active project members." });
  }

  return uniqueIds;
}

async function getQueryDictionary(ctx: TRPCContext, projectId: string): Promise<DashboardQueryDictionary> {
  const [statuses, tags, people, sprints] = await Promise.all([
    ctx.prisma.workflowStatus.findMany({ where: { projectId }, select: { id: true, name: true, category: true } }),
    ctx.prisma.tag.findMany({ where: { projectId }, select: { id: true, name: true } }),
    ctx.prisma.user.findMany({
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
    ctx.prisma.sprint.findMany({ where: { projectId }, select: { id: true, name: true, status: true } }),
  ]);

  return {
    currentUserId: ctx.session?.user.id ?? "",
    statuses,
    tags,
    users: people,
    sprints,
  };
}

async function validateQuery(ctx: TRPCContext, projectId: string, query: string) {
  const dictionary = await getQueryDictionary(ctx, projectId);
  buildTaskWhereFromDashboardQuery(projectId, query, dictionary);
}

async function getDashboardOrThrow(ctx: TRPCContext, dashboardId: string) {
  const dashboard = await ctx.prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: dashboardSelect,
  });

  if (!dashboard) throw new TRPCError({ code: "NOT_FOUND" });
  await requireProjectAccess(ctx.prisma, ctx.session!.user.id, dashboard.projectId);
  if (!visibleToUser(dashboard, ctx.session!.user.id)) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return dashboard;
}

async function requireDashboardManager(ctx: TRPCContext, dashboardId: string) {
  const dashboard = await ctx.prisma.dashboard.findUnique({
    where: { id: dashboardId },
    select: { id: true, projectId: true, ownerId: true },
  });

  if (!dashboard) throw new TRPCError({ code: "NOT_FOUND" });
  const access = await getEffectiveProjectAccess(ctx.prisma, ctx.session!.user.id, dashboard.projectId);
  if (dashboard.ownerId !== ctx.session!.user.id && !access.permissions.has("project_manage")) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return dashboard;
}

async function getSavedFilterOrThrow(ctx: TRPCContext, filterId: string) {
  const filter = await ctx.prisma.savedFilter.findUnique({
    where: { id: filterId },
    select: savedFilterSelect,
  });

  if (!filter) throw new TRPCError({ code: "NOT_FOUND" });
  await requireProjectAccess(ctx.prisma, ctx.session!.user.id, filter.projectId);
  if (!visibleToUser(filter, ctx.session!.user.id)) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return filter;
}

async function requireSavedFilterManager(ctx: TRPCContext, filterId: string) {
  const filter = await ctx.prisma.savedFilter.findUnique({
    where: { id: filterId },
    select: { id: true, projectId: true, ownerId: true },
  });

  if (!filter) throw new TRPCError({ code: "NOT_FOUND" });
  const access = await getEffectiveProjectAccess(ctx.prisma, ctx.session!.user.id, filter.projectId);
  if (filter.ownerId !== ctx.session!.user.id && !access.permissions.has("project_manage")) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return filter;
}

function combineWhere(...where: Prisma.TaskWhereInput[]) {
  return { AND: where } satisfies Prisma.TaskWhereInput;
}

function startOfToday() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return today;
}

function metricWhere(metric: string): Prisma.TaskWhereInput {
  if (metric === "overdue") {
    return {
      dueDate: { lt: startOfToday() },
      closedAt: null,
      status: { category: { notIn: ["done", "cancelled"] } },
    };
  }
  if (metric === "completed") {
    return { OR: [{ closedAt: { not: null } }, { status: { category: { in: ["done", "cancelled"] } } }] };
  }
  if (metric === "unassigned") {
    return { assigneeId: null };
  }
  return {};
}

function monthKey(date: Date) {
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}`;
}

/**
 * Burndown widgets store their chosen sprint in the widget's `query` column
 * (empty = the project's active sprint). The sprint must belong to the
 * dashboard's project.
 */
async function validateBurndownSprintQuery(ctx: TRPCContext, projectId: string, query: string | null | undefined) {
  if (!query) return;
  const sprint = await ctx.prisma.sprint.findUnique({
    where: { id: query },
    select: { id: true, projectId: true },
  });
  if (!sprint || sprint.projectId !== projectId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Burndown sprint must belong to this dashboard project." });
  }
}

interface BurndownWidgetData {
  sprintName: string | null;
  days: ReturnType<typeof computeBurndownDays>;
}

/**
 * Resolve the sprint for a burndown widget (explicit id or the active one) and
 * compute the daily remaining/ideal series from SprintSnapshot rows.
 */
async function buildBurndownWidgetData(ctx: TRPCContext, projectId: string, query: string | null): Promise<BurndownWidgetData> {
  const sprintSelect = {
    id: true,
    projectId: true,
    name: true,
    startDate: true,
    endDate: true,
    status: true,
  } as const;

  let sprint: Prisma.SprintGetPayload<{ select: typeof sprintSelect }> | null = null;
  if (query) {
    sprint = await ctx.prisma.sprint.findUnique({ where: { id: query }, select: sprintSelect });
    if (!sprint || sprint.projectId !== projectId) {
      throw new Error("Burndown sprint no longer exists.");
    }
  } else {
    sprint = await ctx.prisma.sprint.findFirst({
      where: { projectId, status: "active" },
      orderBy: [{ startDate: "asc" }, { order: "asc" }],
      select: sprintSelect,
    });
  }

  if (!sprint) {
    return { sprintName: null, days: [] };
  }

  const snapshots = await ctx.prisma.sprintSnapshot.findMany({
    where: { sprintId: sprint.id },
    select: { date: true, remainingCount: true, completedCount: true },
    orderBy: { date: "asc" },
  });

  const days = computeBurndownDays({
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    snapshots,
  });

  return { sprintName: sprint.name, days };
}

async function buildSeries(ctx: TRPCContext, where: Prisma.TaskWhereInput, groupBy: string | null) {
  if (!groupBy) return [];

  if (groupBy === "status") {
    const [counts, statuses] = await Promise.all([
      ctx.prisma.task.groupBy({ by: ["statusId"], where, _count: { _all: true } }),
      ctx.prisma.workflowStatus.findMany({ select: { id: true, name: true, color: true } }),
    ]);
    return counts.map((item) => {
      const status = statuses.find((candidate) => candidate.id === item.statusId);
      return { key: item.statusId, label: status?.name ?? "Unknown", value: item._count._all, color: status?.color ?? "#6b7280" };
    });
  }

  if (groupBy === "priority") {
    const counts = await ctx.prisma.task.groupBy({ by: ["priority"], where, _count: { _all: true } });
    const colors: Record<string, string> = { urgent: "#ef4444", high: "#f97316", medium: "#f59e0b", low: "#22c55e", none: "#94a3b8" };
    return counts.map((item) => ({ key: item.priority, label: item.priority, value: item._count._all, color: colors[item.priority] ?? "#94a3b8" }));
  }

  if (groupBy === "assignee") {
    const [counts, users] = await Promise.all([
      ctx.prisma.task.groupBy({ by: ["assigneeId"], where, _count: { _all: true } }),
      ctx.prisma.user.findMany({ select: { id: true, name: true, email: true } }),
    ]);
    return counts.map((item) => {
      const user = users.find((candidate) => candidate.id === item.assigneeId);
      return { key: item.assigneeId ?? "unassigned", label: user?.name ?? user?.email ?? "Unassigned", value: item._count._all, color: item.assigneeId ? "#3b82f6" : "#94a3b8" };
    });
  }

  if (groupBy === "sprint") {
    const [counts, sprints] = await Promise.all([
      ctx.prisma.task.groupBy({ by: ["sprintId"], where, _count: { _all: true } }),
      ctx.prisma.sprint.findMany({ select: { id: true, name: true } }),
    ]);
    return counts.map((item) => {
      const sprint = sprints.find((candidate) => candidate.id === item.sprintId);
      return { key: item.sprintId ?? "backlog", label: sprint?.name ?? "No sprint", value: item._count._all, color: item.sprintId ? "#8b5cf6" : "#94a3b8" };
    });
  }

  if (groupBy === "tag") {
    const tasks = await ctx.prisma.task.findMany({ where, select: { id: true, tags: { include: { tag: true } } }, take: 5000 });
    const counts = new Map<string, { key: string; label: string; value: number; color: string }>();
    for (const task of tasks) {
      if (task.tags.length === 0) {
        const current = counts.get("untagged") ?? { key: "untagged", label: "Untagged", value: 0, color: "#94a3b8" };
        current.value += 1;
        counts.set("untagged", current);
      }
      for (const relation of task.tags) {
        const current = counts.get(relation.tag.id) ?? { key: relation.tag.id, label: relation.tag.name, value: 0, color: relation.tag.color };
        current.value += 1;
        counts.set(relation.tag.id, current);
      }
    }
    return [...counts.values()].sort((left, right) => right.value - left.value);
  }

  if (groupBy === "dueMonth") {
    const tasks = await ctx.prisma.task.findMany({ where, select: { dueDate: true }, take: 5000 });
    const counts = new Map<string, number>();
    for (const task of tasks) {
      const key = monthKey(task.dueDate);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => ({ key, label: key, value, color: "#06b6d4" }));
  }

  return [];
}

async function buildWidgetData(ctx: TRPCContext, dashboard: DashboardForView, dictionary: DashboardQueryDictionary) {
  return Promise.all(dashboard.widgets.map(async (widget) => {
    try {
      let query = widget.query ?? "";
      if (widget.savedFilterId) {
        const filter = await ctx.prisma.savedFilter.findUnique({
          where: { id: widget.savedFilterId },
          select: {
            id: true,
            projectId: true,
            ownerId: true,
            visibility: true,
            query: true,
            shares: { select: { userId: true } },
          },
        });

        if (!filter || filter.projectId !== dashboard.projectId) {
          throw new Error("Saved filter no longer exists.");
        }
        if (!visibleToUser(filter, ctx.session!.user.id)) {
          throw new Error("Saved filter is not visible to this user.");
        }
        query = filter.query;
      }

      const displayQuery = widget.savedFilterId ? "" : query;

      if (widget.type === "burndown") {
        const burndown = await buildBurndownWidgetData(ctx, dashboard.projectId, widget.query);
        return {
          id: widget.id,
          title: widget.title,
          type: widget.type,
          total: 0,
          days: burndown.days,
          sprintName: burndown.sprintName,
          query: "",
          metric: widget.metric,
          groupBy: widget.groupBy,
          savedFilterId: widget.savedFilterId ?? undefined,
          error: null,
        };
      }

      const parsed = buildTaskWhereFromDashboardQuery(dashboard.projectId, query, dictionary);
      const where = combineWhere(parsed.where, metricWhere(widget.type === "metric" ? widget.metric : "count"));
      const total = await ctx.prisma.task.count({ where });

      if (widget.type === "table") {
        const tasks = await ctx.prisma.task.findMany({
          where,
          select: {
            id: true,
            taskNumber: true,
            title: true,
            priority: true,
            dueDate: true,
            closedAt: true,
            status: { select: { id: true, name: true, color: true, category: true } },
            assignee: { select: { id: true, name: true, email: true, image: true } },
            project: { select: { key: true, slug: true } },
          },
          orderBy: [{ dueDate: "asc" }, { taskNumber: "asc" }],
          take: 12,
        });
        return { id: widget.id, title: widget.title, type: widget.type, total, tasks, query: displayQuery, metric: widget.metric, groupBy: widget.groupBy, savedFilterId: widget.savedFilterId, error: null };
      }

      if (widget.type === "metric") {
        return { id: widget.id, title: widget.title, type: widget.type, total, metric: widget.metric, query: displayQuery, groupBy: widget.groupBy, savedFilterId: widget.savedFilterId, error: null };
      }

      const series = await buildSeries(ctx, parsed.where, widget.groupBy);
      return { id: widget.id, title: widget.title, type: widget.type, total, series, query: displayQuery, metric: widget.metric, groupBy: widget.groupBy, savedFilterId: widget.savedFilterId, error: null };
    } catch (error) {
      return {
        id: widget.id,
        title: widget.title,
        type: widget.type,
        total: 0,
        query: widget.savedFilterId ? "" : widget.query ?? "",
        metric: widget.metric,
        groupBy: widget.groupBy,
        savedFilterId: widget.savedFilterId,
        error: error instanceof Error ? error.message : "Unable to load widget.",
      };
    }
  }));
}

export const dashboardRouter = createTRPCRouter({
  queryHelp: protectedProcedure.query(() => dashboardQueryHelp()),

  listDashboards: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.dashboard.findMany({
        where: { projectId: input.projectId, ...visibilityWhere(ctx.session.user.id) },
        select: dashboardSelect,
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      });
    }),

  getDashboard: protectedProcedure
    .input(z.object({ dashboardId: z.string().cuid() }))
    .query(async ({ ctx, input }) => getDashboardOrThrow(ctx, input.dashboardId)),

  createDashboard: protectedProcedure
    .input(z.object({
      projectId: z.string().cuid(),
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional().nullable(),
      visibility: visibilitySchema.default("public"),
      shareUserIds: shareUserIdsSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      const shareUserIds = input.visibility === "restricted"
        ? await assertProjectShareUsers(ctx, input.projectId, input.shareUserIds, ctx.session.user.id)
        : [];

      return ctx.prisma.dashboard.create({
        data: {
          projectId: input.projectId,
          ownerId: ctx.session.user.id,
          name: input.name,
          description: input.description || null,
          visibility: input.visibility,
          shares: { create: shareUserIds.map((userId) => ({ userId })) },
        },
        select: dashboardSelect,
      });
    }),

  updateDashboard: protectedProcedure
    .input(z.object({
      dashboardId: z.string().cuid(),
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional().nullable(),
      visibility: visibilitySchema,
      shareUserIds: shareUserIdsSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const dashboard = await requireDashboardManager(ctx, input.dashboardId);
      const shareUserIds = input.visibility === "restricted"
        ? await assertProjectShareUsers(ctx, dashboard.projectId, input.shareUserIds, dashboard.ownerId)
        : [];

      return ctx.prisma.dashboard.update({
        where: { id: input.dashboardId },
        data: {
          name: input.name,
          description: input.description || null,
          visibility: input.visibility,
          shares: {
            deleteMany: {},
            create: shareUserIds.map((userId) => ({ userId })),
          },
        },
        select: dashboardSelect,
      });
    }),

  deleteDashboard: protectedProcedure
    .input(z.object({ dashboardId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireDashboardManager(ctx, input.dashboardId);
      await ctx.prisma.dashboard.delete({ where: { id: input.dashboardId } });
      return { success: true };
    }),

  listSavedFilters: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.savedFilter.findMany({
        where: { projectId: input.projectId, ...visibilityWhere(ctx.session.user.id) },
        select: savedFilterSelect,
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      });
    }),

  validateFilterQuery: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), query: z.string().max(4000).default("") }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      await validateQuery(ctx, input.projectId, input.query);
      return { success: true };
    }),

  createSavedFilter: protectedProcedure
    .input(z.object({
      projectId: z.string().cuid(),
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional().nullable(),
      query: z.string().max(4000).default(""),
      visibility: visibilitySchema.default("public"),
      shareUserIds: shareUserIdsSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      await validateQuery(ctx, input.projectId, input.query);
      const shareUserIds = input.visibility === "restricted"
        ? await assertProjectShareUsers(ctx, input.projectId, input.shareUserIds, ctx.session.user.id)
        : [];

      return ctx.prisma.savedFilter.create({
        data: {
          projectId: input.projectId,
          ownerId: ctx.session.user.id,
          name: input.name,
          description: input.description || null,
          query: input.query,
          visibility: input.visibility,
          shares: { create: shareUserIds.map((userId) => ({ userId })) },
        },
        select: savedFilterSelect,
      });
    }),

  updateSavedFilter: protectedProcedure
    .input(z.object({
      filterId: z.string().cuid(),
      name: z.string().min(1).max(120),
      description: z.string().max(500).optional().nullable(),
      query: z.string().max(4000).default(""),
      visibility: visibilitySchema,
      shareUserIds: shareUserIdsSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      const filter = await requireSavedFilterManager(ctx, input.filterId);
      await validateQuery(ctx, filter.projectId, input.query);
      const shareUserIds = input.visibility === "restricted"
        ? await assertProjectShareUsers(ctx, filter.projectId, input.shareUserIds, filter.ownerId)
        : [];

      return ctx.prisma.savedFilter.update({
        where: { id: input.filterId },
        data: {
          name: input.name,
          description: input.description || null,
          query: input.query,
          visibility: input.visibility,
          shares: {
            deleteMany: {},
            create: shareUserIds.map((userId) => ({ userId })),
          },
        },
        select: savedFilterSelect,
      });
    }),

  deleteSavedFilter: protectedProcedure
    .input(z.object({ filterId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await requireSavedFilterManager(ctx, input.filterId);
      await ctx.prisma.savedFilter.delete({ where: { id: input.filterId } });
      return { success: true };
    }),

  addWidget: protectedProcedure
    .input(z.object({
      dashboardId: z.string().cuid(),
      title: z.string().min(1).max(120),
      type: widgetTypeSchema,
      groupBy: groupBySchema.optional().nullable(),
      metric: metricSchema.default("count"),
      savedFilterId: z.string().cuid().optional().nullable(),
      query: z.string().max(4000).optional().nullable(),
      width: z.number().int().min(1).max(2).default(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const dashboard = await requireDashboardManager(ctx, input.dashboardId);
      if (input.savedFilterId) {
        const filter = await getSavedFilterOrThrow(ctx, input.savedFilterId);
        if (filter.projectId !== dashboard.projectId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Saved filter must belong to this dashboard project." });
        }
      }
      if (!input.savedFilterId && input.query) {
        if (input.type === "burndown") {
          await validateBurndownSprintQuery(ctx, dashboard.projectId, input.query);
        } else {
          await validateQuery(ctx, dashboard.projectId, input.query);
        }
      }

      const maxOrder = await ctx.prisma.dashboardWidget.aggregate({
        where: { dashboardId: input.dashboardId },
        _max: { order: true },
      });

      return ctx.prisma.dashboardWidget.create({
        data: {
          dashboardId: input.dashboardId,
          title: input.title,
          type: input.type,
          groupBy: input.type === "metric" || input.type === "table" ? null : input.groupBy,
          metric: input.metric,
          savedFilterId: input.savedFilterId || null,
          query: input.savedFilterId ? null : input.query || null,
          width: input.width,
          order: (maxOrder._max.order ?? -1) + 1,
        },
      });
    }),

  updateWidget: protectedProcedure
    .input(z.object({
      widgetId: z.string().cuid(),
      title: z.string().min(1).max(120),
      type: widgetTypeSchema,
      groupBy: groupBySchema.optional().nullable(),
      metric: metricSchema.default("count"),
      savedFilterId: z.string().cuid().optional().nullable(),
      query: z.string().max(4000).optional().nullable(),
      width: z.number().int().min(1).max(2).default(1),
    }))
    .mutation(async ({ ctx, input }) => {
      const widget = await ctx.prisma.dashboardWidget.findUnique({ where: { id: input.widgetId }, select: { dashboardId: true } });
      if (!widget) throw new TRPCError({ code: "NOT_FOUND" });
      const dashboard = await requireDashboardManager(ctx, widget.dashboardId);
      if (input.savedFilterId) {
        const filter = await getSavedFilterOrThrow(ctx, input.savedFilterId);
        if (filter.projectId !== dashboard.projectId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Saved filter must belong to this dashboard project." });
        }
      }
      if (!input.savedFilterId && input.query) {
        if (input.type === "burndown") {
          await validateBurndownSprintQuery(ctx, dashboard.projectId, input.query);
        } else {
          await validateQuery(ctx, dashboard.projectId, input.query);
        }
      }

      return ctx.prisma.dashboardWidget.update({
        where: { id: input.widgetId },
        data: {
          title: input.title,
          type: input.type,
          groupBy: input.type === "metric" || input.type === "table" ? null : input.groupBy,
          metric: input.metric,
          savedFilterId: input.savedFilterId || null,
          query: input.savedFilterId ? null : input.query || null,
          width: input.width,
        },
      });
    }),

  deleteWidget: protectedProcedure
    .input(z.object({ widgetId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const widget = await ctx.prisma.dashboardWidget.findUnique({ where: { id: input.widgetId }, select: { dashboardId: true } });
      if (!widget) throw new TRPCError({ code: "NOT_FOUND" });
      await requireDashboardManager(ctx, widget.dashboardId);
      await ctx.prisma.dashboardWidget.delete({ where: { id: input.widgetId } });
      return { success: true };
    }),

  getDashboardData: protectedProcedure
    .input(z.object({ dashboardId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const dashboard = await getDashboardOrThrow(ctx, input.dashboardId);
      const dictionary = await getQueryDictionary(ctx, dashboard.projectId);
      const widgets = await buildWidgetData(ctx, dashboard, dictionary);
      return { dashboardId: dashboard.id, widgets };
    }),
});
