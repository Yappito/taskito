# Phase 4: Analytics, pagination, sprint order, status deletion

## Context

Critical B2 and highs B5/B6/B9 from `docs/taskito-fixes-plan/00-overview.md`.
`analytics.projectSummary` caps at `take: 500` and reports truncated numbers; task
list cursor pagination over non-unique `dueDate` is unstable; sprint.list orders by
enum alphabetically; deleteStatus fails with an opaque FK error when tasks use the status.

## Scope (files you may touch)

- `src/server/routers/analytics.ts`
- `src/server/routers/task.ts` (only the `list` pagination block, lines ~339-478)
- `src/server/routers/sprint.ts` (only `list`, lines ~80-97)
- `src/server/routers/workflow.ts` (only `deleteStatus`, lines ~167-180)
- Tests: `src/server/routers/__tests__/` (new analytics test, workflow deleteStatus test)
- `docs/taskito-fixes-plan/STATUS.md`

## Tasks

### T4.1 — Analytics: real counts, not truncated arrays
In `src/server/routers/analytics.ts` (`projectSummary`, lines 19-101):
- Replace `findMany({ take: 500 })`-based totals with DB-side counts:
  - `totalTasks` = `prisma.task.count({ where: baseWhere })`.
  - `activeTasks` = count with archived filter (`archivedAt is null OR archivedAt > now`).
  - `completedTasks` = count where `closedAt != null OR status.category in ("done","cancelled")`.
  - `overdueTasks` = count where active AND `dueDate < today` AND not closed/cancelled.
  - `completionRate` = completed/total.
- Distributions: `statusDistribution` and `priorityDistribution` via
  `prisma.task.groupBy({ by: ["statusId"], _count: true, where: baseWhere })` and
  `groupBy({ by: ["priority"], ... })`; join status names via a single
  `workflowStatus.findMany` fetch. Keep the response shape EXACTLY (invariants.md:
  `{ id, name, color, count }` per status entry; `{ priority, count }` per priority).
- Velocity: keep the 7-day window but compute per-day created/completed with
  `groupBy` on `createdAt`/`closedAt` using `gte`/`lt` day buckets (7 small counts,
  or one groupBy per field with a `where` covering the 7-day window). Keep the
  `velocity` array shape `{ date, created, completed }`.
- `avgCycleTimeHours`: needs per-task closedAt+createdAt — either keep a bounded
  fetch (e.g. `take: 500` of completed tasks for cycle-time only, clearly scoped to
  completed tasks, ordered by closedAt desc) or compute via raw SQL. Prefer a
  bounded completed-only fetch; document that cycle time is sampled on the most
  recent 500 completed tasks. This is acceptable and must be noted in the response
  or code comment.
- `atRiskTasks`: keep `overdueTasks.slice(0, 10)` — now derived from the overdue
  count query's top 10 (fetch the top 10 overdue tasks separately with a small query).
- `loggedSeconds` unchanged (already aggregate).

### T4.2 — Stable cursor pagination
In `src/server/routers/task.ts` `list` (line 459):
- Change `orderBy: { dueDate: "asc" }` to
  `orderBy: [{ dueDate: "asc" }, { taskNumber: "asc" }]`.
- Keep `cursor: { id: cursor }, skip: 1`. The Prisma requirement is that the cursor
  field participates in ordering — since the cursor is `id` and orderBy uses
  `taskNumber`, add `id` as the final tiebreaker: `orderBy: [{ dueDate: "asc" }, { taskNumber: "asc" }, { id: "asc" }]`.
- Verify `limit + 1` / `nextCursor` logic still works (it uses `items.pop()` — fine).

### T4.3 — Sprint list workflow order
In `src/server/routers/sprint.ts` `list` (line 95):
- The schema has `status SprintStatus` enum and an `order Int` field (verify field
  name in prisma/schema.prisma — `order` is used in `create` at line 134).
- Order by workflow semantics: use the numeric `order` field first, then
  `startDate desc`: `orderBy: [{ order: "asc" }, { startDate: "desc" }]`.
- If `order` is not a column, implement a `status` case mapping
  (planned < active < completed) via raw SQL or a computed sort key in JS after
  fetch. Prefer the DB field if it exists.
- Keep the include/select unchanged.

### T4.4 — deleteStatus friendly pre-check
In `src/server/routers/workflow.ts` `deleteStatus` (line 167):
- Before the delete, run `task.count({ where: { statusId: input.id } })`.
- If count > 0 → throw `new Error(\`Cannot delete status: ${count} task(s) still use it\`)` (or a
  clear message stating tasks must be moved first). Match existing error style
  (plain Error with message, thrown inside the mutation).
- Keep the transaction + `syncProjectClosedTasks` call for the success path.
- Check schema: `WorkflowStatus` may have `onDelete: Restrict` on Task.statusId —
  the pre-check makes the error human-readable instead of a Prisma P2003.

### T4.5 — Tests
- New `src/server/routers/__tests__/analytics-router.test.ts`:
  - >500 tasks: totalTasks/counts are correct (seed 600 tasks via a mocked prisma
    count/groupBy or a test DB — use whatever pattern existing router tests use).
  - Response shape matches invariants (keys present).
- New `src/server/routers/__tests__/workflow-delete-status.test.ts`:
  - deleteStatus with tasks in the status throws a friendly error and does not delete.
  - deleteStatus with zero tasks succeeds.

## Definition of done

1. Analytics uses DB counts/groupBy; no `take: 500` truncation of totals.
2. Response shapes unchanged (invariants).
3. Pagination orderBy stable (dueDate, taskNumber, id).
4. Sprint list ordered by workflow order.
5. deleteStatus pre-checks and errors clearly.
6. Tests pass; `npm test` (all), `npx tsc --noEmit`, `npm run build` all pass.
