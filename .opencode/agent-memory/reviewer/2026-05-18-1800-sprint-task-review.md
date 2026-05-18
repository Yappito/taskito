---
agent: reviewer
created: 2026-05-18T18:00:00Z
scope: sprint-view, task-detail, ai-streaming, e2e-tests, prisma-migrations
type: review
confidence: high
---

# Sprint, task-detail, AI streaming, Playwright test review

## Summary

The changeset is large but structurally coherent — it adds sprint management, time tracking, recurrence, automation rules, AI native tool calling, AI streaming, and new view types (dashboard, calendar, gantt). The code quality is generally good with proper authorization checks, rate limiting, and optimistic updates. However, there are several material defects that should be fixed before committing.

## Findings

### HIGH — Completed-sprint guard missing from `validateSprintAccess` in task router

**Files:** `src/server/routers/task.ts` (lines 85–110), `src/server/routers/sprint.ts` (lines 260–267)

**Issue:** The `validateSprintAccess` function in `task.ts` checks that a sprint exists and belongs to the project, but does NOT verify that the sprint is not in `"completed"` status. The sprint-specific `assignTask` endpoint blocks assignment to completed sprints, but the general task `create`, `update`, and `bulkUpdate` mutations call `validateSprintAccess` which skips this check. A user can assign a task to a completed sprint via the task detail edit form or bulk action bar.

**Failure scenario:**
1. Mark a sprint as completed.
2. Edit a task via the task detail form and set its sprint to the completed sprint.
3. The mutation succeeds. The task is now assigned to a completed sprint.
4. Sprint view filtering may break — tasks in completed sprints may not appear in lane grouping.

**Fix:** Add a status check in `validateSprintAccess`:
```ts
if (sprint.status === "completed") {
  throw new Error("Cannot assign tasks to a completed sprint");
}
```
Change the `findUnique` select to include `status`, and add the guard. Apply uniformly in `create`, `update`, and `bulkUpdate`.

### MEDIUM — Recurrence rule accepts past `nextDueDate`, causing immediate duplicate

**File:** `src/components/recurrence/recurrence-controls.tsx` (lines 36–42)

**Issue:** The form submits `nextDueDate` from user input. If the value is in the past (e.g., the task's due date was yesterday), the cron-only `processDueRecurrences` will fire immediately on the next cron tick and create a duplicate task occurrence.

**Failure scenario:**
1. Navigate to a task with a past due date.
2. Set a recurrence rule (the form defaults `nextDueDate` to the task's due date).
3. Cron fires → duplicate task is created instantly.

**Fix:** Add client-side validation that `nextDueDate` must be >= today, or clamp it server-side in the `recurrence.set` mutation.

### MEDIUM — AI streaming API route `assertSameOrigin` fragile behind proxies

**File:** `src/app/api/ai/stream/route.ts` (lines 18–28)

**Issue:** `assertSameOrigin` compares `new URL(request.url).origin` to the `Origin` header. Behind a reverse proxy (common in self-hosted deployments), `request.url` may reflect the internal origin while the client sends a different external `Origin`. The function would reject the request.

**Failure scenario:**
- Deploy behind nginx/caddy with domain rewriting — all AI streaming requests fail with 403.

**Fix:** Relax the check to allow missing `Origin` when the request already carries a valid session (the session check on line 53 provides auth). Alternatively, compare against a configured `APP_URL` or `TRUSTED_ORIGINS` env var instead of `request.url`.

### MEDIUM — Sprint view loads archived tasks

**File:** `src/components/sprint/sprint-view.tsx` (line 81)

**Issue:** The sprint view's `task.list` query passes `includeArchived: true`. Archived tasks that were previously in the sprint will appear in the sprint board columns, which is likely confusing — sprints should show active work only.

**Fix:** Change to `includeArchived: false` (or remove the parameter to use the default).

### LOW — Hardcoded seeded task titles in Playwright tests

**File:** `e2e/backlog-coverage.spec.ts` (lines 289, 290, 304, 418, 422, 438)

**Issue:** Tests reference specific seeded task titles ("Add drag-and-drop to board", "Design database schema"). If the seed data changes or these tasks are removed/renamed, tests will fail with no useful diagnostic — the failure will look like a locator timeout.

**Fix:** Create the required tasks programmatically at the start of each test (using `createTask` helper) rather than relying on seed data. Or export seed task titles from a constant.

### LOW — `getEffectiveConversation` double-spreads `selectedTaskIds` as raw JSON

**File:** `src/app/api/ai/stream/route.ts` (lines 30–50)

**Issue:** The `getEffectiveConversation` function spreads the conversation object (`...conversation`) and then overrides `grantedPermissions`. The spread includes `selectedTaskIds` as-is (a `Prisma.JsonValue`), which downstream code expects as `string[]`. In `buildAiAssistantTurnRequest` / `appendAiAssistantTurn`, the value is checked with `Array.isArray(input.conversation.selectedTaskIds)`. Prisma returns JSON fields as parsed JS values, so this works in practice, but if the value is `null` it could throw.

**Fix:** Normalize `selectedTaskIds` explicitly in `getEffectiveConversation` to `string[] | undefined` like the AI router does with `getConversationSelectedTaskIds`.

## Next steps

1. Fix the completed-sprint guard in `task.ts` — this is the highest-risk defect.
2. Add past-date validation to recurrence controls.
3. Consider the proxy scenario for the streaming endpoint or document it.
4. Change sprint view to exclude archived tasks.
5. Remove reliance on seeded task titles in Playwright tests.
