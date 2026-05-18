---
agent: reviewer
created: 2026-05-18T15:00:00Z
scope: task.ts, recurrence.ts, recurrence-controls.tsx, sprint-view.tsx, backlog-coverage.spec.ts
type: review
confidence: high
---

# Sprint guard, recurrence validation, and e2e changes review

## Summary

Reviewed five files for a changeset adding a completed-sprint guard, recurrence `nextDueDate` validation, sprint-view archived-task exclusion, and e2e test robustness. No blocking or high-severity findings. Two medium concerns around test seed-data dependency and query performance, and two low concerns around component state staleness and a timezone edge case.

## Evidence

### Medium — e2e "blocks links" test depends on seed data

`e2e/backlog-coverage.spec.ts` line 403:
```ts
const blockedTitle = "Add drag-and-drop to board";
```
This test no longer creates its own blocked task; it references a hardcoded seed task. If the seed dataset is ever changed (task renamed, removed, or the seeded project changes), this test will fail silently. The parent/child tests (lines 419–463) still create their own tasks and are self-contained.

### Medium — `task.list` now includes unrestricted `timeLogs`

`src/server/routers/task.ts` lines 402–403: the `list` procedure now includes `timeLogs` with no `take`/`where`/`orderBy`. For tasks with many time entries, this increases query payload and memory usage substantially. Previously time logs were only included in the `byId` detail endpoint. The list endpoint is used by board/list views and the sprint view with `limit: 100`.

### Low — `recurrence-controls.tsx` stale initial state on prop change

`src/components/recurrence/recurrence-controls.tsx` lines 24–27: the `nextDueDate` state is initialized with a `useState` function initializer that reads `rule?.nextDueDate ?? dueDate`. If `rule` or `dueDate` props change after initial mount (e.g., from a task refetch), `nextDueDate` will not update to reflect the new values. This component is typically stable during its lifecycle, so the practical impact is minimal.

### Low — recurrence date validation timezone edge case

`src/server/routers/recurrence.ts` lines 30–36: the `superRefine` compares `dateKey(value.nextDueDate) < dateKey(new Date())` using UTC-based ISO date strings. A client in a negative-UTC offset (e.g., UTC-12) could submit a date that is "today" locally but "yesterday" in UTC, triggering a false rejection. Pattern is consistent with the rest of the codebase.

## Details

### Completed-sprint guard (task.ts)

`validateSprintAccess` (lines 88–114) correctly rejects non-existent sprints, cross-project sprints, and completed sprints. Called in `create`, `update`, and `bulkUpdate` before any write. The guard is applied to the target sprint, so existing tasks in completed sprints are not affected.

### Recurrence nextDueDate validation (recurrence.ts)

The `superRefine` validates `nextDueDate <= endDate` (when endDate is set) and `nextDueDate >= today`. The `dateKey` helper strips time for date-only comparison. The form (`recurrence-controls.tsx`) also has a client-side guard (`nextDueDate < today`) for immediate feedback.

### Sprint view archived-task exclusion (sprint-view.tsx)

`taskListInput` at line 80 sets `includeArchived: false`. This correctly excludes archived tasks from the sprint board. Previously the list query defaulted to excluding archived tasks only if `includeArchived` was `false`, but the sprint view didn't pass it explicitly — now it does.

### Completed-sprint collapse logic (sprint-view.tsx)

Lines 178–192: auto-collapses completed sprints on first view. User toggle preferences are preserved across sprint switches via the `collapsedSprints` state map. The `??` operator on line 179 correctly falls through to the status check only when no explicit toggle has been stored.

### E2E test improvements (backlog-coverage.spec.ts)

All changes reduce flakiness: `exact: true` for role selectors, explicit visibility assertions before clicks (`toBeVisible`), `closeTaskDetail` calls before navigation, `escapeRegex` for dynamic title matching, and `click()` instead of `uncheck()/check()` for checkbox toggles.

## Next steps

- Consider adding a `take` or filter on the `timeLogs` include in `task.list` to limit per-task time log data.
- Watch for seed-data changes that could break the "blocks links" test.
- No action needed on the low-severity items; they are consistent with existing patterns.
