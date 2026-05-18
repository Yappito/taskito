---
agent: reviewer
created: 2026-05-13T10:00:00Z
scope: pending sprint-member and sprint UX changes
type: review
confidence: high
---

# Review Summary

Reviewed pending changes: sprint router, sprint-view component, SprintMember migration/schema, and e2e tests. Prisma schema and migration are consistent. No critical blocking issues. One medium-severity race condition in member validation, plus test fragility and minor edge cases.

## Medium Severity

### 1. Race condition: `validateSprintMembers` called outside `$transaction` in `update` mutation

**File:** `src/server/routers/sprint.ts:124-127`

```typescript
const memberIds = input.memberIds !== undefined
  ? await validateSprintMembers(ctx.prisma, sprint.projectId, input.memberIds)
  : null;
return ctx.prisma.$transaction(async (tx) => {
  // ... deleteMany + createMany using memberIds from line 124-126
});
```

**Issue:** `validateSprintMembers` checks that every user ID has a row in `ProjectMember` for this project. But this check runs BEFORE the `$transaction`. Between the check and the actual DB writes, a concurrent request can delete the `ProjectMember` row. The `SprintMember.userId` FK references `User.id` (not `ProjectMember`), so no constraint violation occurs. The result: a user who was removed from the project in between gets added as a sprint member anyway, violating the application invariant "sprint members must be project members."

**Failure scenario:** Admin removes User A from the project. Simultaneously, another admin calls `sprint.update` or `assignMembers` with User A's ID. The validation passes (User A still has a ProjectMember row). Before the transaction commits, the ProjectMember row is deleted. The SprintMember insertion succeeds. User A is now a sprint member but not a project member.

**Fix direction:** Move the `validateSprintMembers` call inside the `$transaction` and use a `SELECT ... FOR UPDATE` lock on the relevant `ProjectMember` rows (via Prisma raw query or by wrapping the read inside the transaction with an explicit lock). Alternatively, accept this as a low-impact race and document it. The simplest safe fix is to move validation into the transaction and rely on snapshot isolation — in practice PG's default READ COMMITTED means the second concurrent `DELETE` won't be visible within the transaction, so the insert succeeds but the invariant is still broken. A `SELECT ... FOR UPDATE` is needed for strict correctness.

### 2. `update` mutation date validation only fires when both dates are provided

**File:** `src/server/routers/sprint.ts:121`

```typescript
if (input.startDate && input.endDate && input.endDate < input.startDate) {
```

If only `startDate` changes to a date after the existing `endDate` (or vice versa), the invalid date pair is silently written. The DB has no CHECK constraint to catch it either. This is a minor edge case — the UI always sets both dates together in the create form, but the API allows independent updates.

**Fix direction:** Also validate against the persisted sprint dates when only one date is being changed:
```typescript
const currentSprint = await ...;
const effectiveStart = input.startDate ?? currentSprint.startDate;
const effectiveEnd = input.endDate ?? currentSprint.endDate;
if (effectiveEnd < effectiveStart) throw ...
```

## Low Severity

### 3. E2E test uses fragile broad checkbox locator

**File:** `e2e/expanded-coverage.spec.ts:234`

```typescript
await expect(page.locator('input[type="checkbox"]').filter({ has: page.locator('xpath=..') }).first()).toBeChecked();
```

This matches ALL checkboxes on the page and asserts the first DOM one is checked. It works today only because the sprint view has no checkboxes before the member assignment section, and people order is consistent. If any checkbox is rendered earlier (e.g., a select-all or filter checkbox), this assertion silently matches the wrong element. Prefer scoping to the member assignment section: `page.locator('section:has(h4:text("Assign project members")) input[type="checkbox"]').first()`.

### 4. E2E `dragSprintTaskBetweenColumns` uses raw mouse events without ensuring pointer capture readiness

**File:** `e2e/expanded-coverage.spec.ts:57-60`

The helper fires `mouse.move`, `mouse.down`, `mouse.move`, `mouse.up` directly. The SprintView uses pointer events with `setPointerCapture`. Playwright's mouse API dispatches mouse events, not pointer events. Browsers synthesize pointer events from mouse events, but pointer capture behavior via `element.setPointerCapture()` is only guaranteed when the pointer is in the "active buttons" state. The mouse up/down/move sequence works in practice because browsers do the synthesis, but this is less reliable than using Playwright's drag API (`page.locator().dragTo()`) or dispatching explicit PointerEvent constructors. Flakiness in CI is the main risk.

### 5. Completed-sprint task assignment not gated

**File:** `src/server/routers/sprint.ts:200-211`

`assignTask` checks sprint-project compatibility but does not reject assignments to completed sprints. The UI does not expose this path (tasks are not drag-assignable into completed sprints), but the API allows it. No data corruption risk, but semantically odd.

## Schema/Migration Consistency

✅ `prisma/schema.prisma` SprintMember model matches `20260513100000_add_sprint_members/migration.sql` exactly (fields, types, PK, FK, indexes).

✅ The `@@index([projectId, sprintId])` on Task (added in this changeset) corresponds to `Task_projectId_sprintId_idx` created by the already-committed migration `20260512160000_add_state_of_art_workflows`. The pending schema change resolves the mismatch flagged in the previous review.

✅ Cascade/SetNull behavior on SprintMember FK matches schema.

No mismatches found.

## Open Questions / Unverified

- The `Sprint` table's `name` column has a `@@unique([projectId, name])` constraint. If two sprints are created concurrently with the same name, Prisma throws a unique constraint violation. This is already handled at the DB level (no application-level retry). Acceptable for now.
- The `order` column on Sprint defaults to 0 and increments from max+1 at creation. No reordering endpoint exists. If sprints are deleted, gaps appear. This is cosmetic only.
