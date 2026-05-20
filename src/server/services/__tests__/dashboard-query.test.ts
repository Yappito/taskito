import { describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";

import { buildTaskWhereFromDashboardQuery, type DashboardQueryDictionary } from "@/server/services/dashboard-query";

const dictionary: DashboardQueryDictionary = {
  currentUserId: "user-current",
  statuses: [
    { id: "status-todo", name: "Todo", category: "todo" },
    { id: "status-done", name: "Done", category: "done" },
  ],
  tags: [
    { id: "tag-backend", name: "Backend" },
    { id: "tag-ui", name: "UI" },
  ],
  users: [
    { id: "user-current", name: "Current User", email: "current@example.com" },
    { id: "user-other", name: "Other User", email: "other@example.com" },
  ],
  sprints: [
    { id: "sprint-active", name: "Sprint 1", status: "active" },
  ],
};

function andClauses(where: Prisma.TaskWhereInput) {
  return where.AND as Prisma.TaskWhereInput[];
}

describe("dashboard query", () => {
  it("builds Prisma filters from JQL-style clauses", () => {
    const result = buildTaskWhereFromDashboardQuery(
      "project-1",
      "status = Done AND priority in (high, urgent) AND assignee = me()",
      dictionary
    );

    expect(andClauses(result.where)).toEqual(expect.arrayContaining([
      { projectId: "project-1" },
      { statusId: { in: ["status-done"] } },
      { priority: { in: ["high", "urgent"] } },
      { assigneeId: { in: ["user-current"] } },
    ]));
  });

  it("excludes archived tasks unless query opts in", () => {
    const defaultQuery = buildTaskWhereFromDashboardQuery("project-1", "", dictionary);
    expect(andClauses(defaultQuery.where)[1]).toEqual({ OR: [{ archivedAt: null }, { archivedAt: { gt: expect.any(Date) } }] });

    const archivedQuery = buildTaskWhereFromDashboardQuery("project-1", "archived = true", dictionary);
    expect(andClauses(archivedQuery.where)).toHaveLength(2);
    expect(andClauses(archivedQuery.where)[1]).toEqual({ archivedAt: { not: null, lte: expect.any(Date) } });
  });

  it("supports tags, active sprint, and text contains", () => {
    const result = buildTaskWhereFromDashboardQuery(
      "project-1",
      "tag in (Backend, UI) AND sprint = active() AND text ~ \"login bug\"",
      dictionary
    );

    expect(andClauses(result.where)).toEqual(expect.arrayContaining([
      { tags: { some: { tagId: { in: ["tag-backend", "tag-ui"] } } } },
      { sprintId: { in: ["sprint-active"] } },
      {
        OR: [
          { title: { contains: "login bug", mode: "insensitive" } },
          { body: { contains: "login bug", mode: "insensitive" } },
        ],
      },
    ]));
  });
});
