---
agent: debugger
created: 2026-05-13
scope: e2e
type: root-cause-analysis
confidence: high
---

# Playwright Suite Failures — Root Cause Analysis

## Summary

8 out of 56 e2e tests are failing across 3 spec files after recent UI and dialog changes. Root causes fall into 5 distinct categories: TaskSearchInput data readiness, Dialog effect cleanup interrupting input, drag coordinate drift after CSS layout change, filter-preset button ambiguity, and tRPC cache invalidation timing.

## Test Results Overview

| Spec file | Pass | Fail | Failing tests |
|-----------|------|------|---------------|
| login.spec.ts | 3 | 0 | — |
| features.spec.ts | 22 | 2 | drag-back, quick-add focus |
| backlog-coverage.spec.ts | 6 | 4 | saved presets, 3x link tests |
| broad-coverage.spec.ts | 5 | 2 | link creation, bulk actions |
| expanded-coverage.spec.ts | 12 | 0 | — |
| workflow-features.spec.ts | 9 | 0 | — |
| **Total** | **56** | **8** | |

## Failure 1: TaskSearchInput — link search result button never found (4 tests)

**Files:**
- `e2e/backlog-coverage.spec.ts` lines 154 (3 tests: blocks, parent, child links)
- `e2e/broad-coverage.spec.ts` line 66

**Evidence:**
```
locator.click: Test timeout of 30000ms exceeded.
- waiting for locator('.fixed.inset-y-0.right-0').locator('button')
  .filter({ hasText: 'Blocked Task 1778702300554-2110' }).first()
```

Both selector patterns fail:
- `detailPanel.locator('button').filter({ hasText: targetTitle })` (backlog-coverage)
- `detailPanel.getByRole('button', { name: new RegExp(targetTitle) })` (broad-coverage)

**Root cause (most likely):**  
The `TaskSearchInput` component (`src/components/ui/task-search-input.tsx`) receives `tasks` from `otherTasks`, which is derived from `siblingTasks` — a `trpc.task.list.useQuery()` call in `TaskDetail` (`src/components/task/task-detail.tsx` lines 97-99). The query has `{ enabled: !!task?.projectId }`, meaning it only starts when `task.projectId` is available. If the `siblingTasks` query hasn't resolved when the test clicks "Search for a task..." and types the filter, `otherTasks` is `[]`, so no result buttons render. The test does not wait for results to appear before clicking.

**Contributing factor:**  
`backlog-coverage.spec.ts` added its own `addTaskLink` function (recent commit `6b06ae8`) that uses `.fill()` on `<input>` with `value={search}` and controlled React state. The `fill()` dispatches native input events, but React's controlled input handling may not trigger the expected filtering synchronously.

**Fix direction:**  
Before clicking a search result, wait for at least one result button to appear:
```typescript
await detailPanel.getByRole('button', { name: new RegExp(targetTitle) }).first().waitFor({ timeout: 10_000 });
```
Or, prefetch `task.list` in the `openBoardTaskDetail` helper before interacting with the link form.

## Failure 2: Quick-add description — `pressSequentially` only types "Typ" (1 test)

**File:** `e2e/features.spec.ts` line 167

**Evidence:**
```
Expected: "Typing stays in description"
Received: "Typ"
```
Only 3 of 26 characters made it through.

**Root cause (likely):**  
The `Dialog` component (`src/components/ui/dialog.tsx`) was modified in commit `6b06ae8` ("fix: preserve dialog field focus on rerender"). The change removed `onClose` from the `useEffect` dependency array (line 105) and introduced `onCloseRef` (lines 33-37). The cleanup effect (line 103) calls `previouslyFocusedElement?.focus()`. If a React reconciliation causes the Dialog to briefly unmount then remount (for example, if the "New Task" button that sets `open=true` rerenders), the cleanup would steal focus from the description textarea, and React would lose intermediate controlled-input state updates.

The truncation to exactly "Typ" (3 chars) suggests a specific mechanism: the first 3 keystrokes trigger a batch state update, then a reconciliation cycle resets the textarea value via `<textarea value={body} onChange={...}>`. The last committed `body` value before the reconciliation was "Typ".

**Fix direction:**  
Investigate why the Dialog's `open` prop temporarily flips during typing. The likely culprit is that the "New Task" trigger button's parent rerender causes `open` to go `false → true`. Add a guard in `quick-add.tsx` to prevent the Dialog from reopening if already open. Alternatively, the Dialog's cleanup should not call `previouslyFocusedElement?.focus()` if the dialog is reopening.

## Failure 3: Board drag-back — second drag fails to land (1 test)

**File:** `e2e/features.spec.ts` line 70

**Evidence:**
```
element(s) not found — `[data-board-status-name="Backlog"] [data-board-task-id="..."]`
```
First drag (Backlog → To Do) succeeds, drag-back (To Do → Backlog) fails.

**Root cause:**  
The UI overhaul commit (`d80815b`) changed board column layout:
- Column width: `w-72` → `w-80` (+32px)
- Padding: `p-3` → `p-3.5` (+2px each side)
- Card spacing: `space-y-2` → `space-y-3` (+4px)
- Column border-radius: `rounded-lg` → `rounded-3xl`

The `dragTaskBetweenColumns` helper (line 29-33) uses hardcoded pixel offsets:
```
page.mouse.move(sourceBox.x + sourceBox.width/2, sourceBox.y + 24)
page.mouse.move(targetBox.x + targetBox.width/2, targetBox.y + 96, { steps: 12 })
```

The `y + 24` and `y + 96` offsets were tuned for the old layout. After the column header height changed (header now wraps in a `rounded-2xl border p-3` container vs. a plain `flex items-center justify-between`), the target drop zone is at a different vertical position. The first drag happens to still hit the target zone, but the second drag misses because the card is now in a different column with different scroll/layout state.

**Fix direction:**  
Replace hardcoded offsets with relative calculations:
```typescript
const targetCenterY = targetBox.y + targetBox.height / 2;
// Or target the center of the status header within the column
```
Or use Playwright's built-in `dragTo()` method which handles coordinate calculation.

## Failure 4: Saved filter presets — strict mode violation (1 test)

**File:** `e2e/backlog-coverage.spec.ts` line 328

**Evidence:**
```
strict mode violation: getByRole('button', { name: 'Preset 1778702271847-6808' })
resolved to 2 elements
```

Two buttons have the same accessible name: the preset name button and the delete preset button (which has `aria-label="Delete preset Preset ..."`). The `name` option in `getByRole` uses accessible name computation, and both buttons match.

**Root cause:**  
The recently modified `getByRole("button", { name: presetName })` uses `name` without `exact: true`. The delete button's accessible label "Delete preset Preset 1778702271847-6808" contains the preset name and matches the `name` filter (non-exact matching).

**Fix direction:**  
Add `exact: true` to the selector:
```typescript
await page.getByRole("button", { name: presetName, exact: true }).click();
```

## Failure 5: Bulk actions — status change not reflected in board (1 test)

**File:** `e2e/broad-coverage.spec.ts` line 91

**Evidence:**
```
expect(locator).toBeVisible failed
Locator: '[data-board-status-name="In Progress"]'
```
Tasks don't appear in "In Progress" after bulk status update.

**Root cause (hypothesis):**  
The `bulkUpdate` mutation (`src/server/routers/task.ts` line 947) sends a tRPC mutation that succeeds, but the subsequent `utils.task.list.invalidate()` call triggers a refetch that either:
1. Returns stale data because the `task.list` query uses `placeholderData: (previousData) => previousData` (board-view.tsx line 77), keeping the UI stuck on old data
2. The refetch returns the correct data but the test's `getByText(firstTitle)` doesn't match because the search filter "Bulk Task" still matches, but the task card renders differently in the new column

**Fix direction:**  
Verify the tRPC refetch actually returns updated data. Add `await page.waitForTimeout(500)` between applying the bulk action and checking the result. Consider using `await utils.task.list.invalidate()` (with `await`) instead of fire-and-forget.

## Selector Drift Assessment

- `[data-board-task-id]` and `[data-board-status-name]` — still present in `board-view.tsx` lines 483, 430. **No drift.**
- `.fixed.inset-y-0.right-0` — still present in `task-detail.tsx` lines 224, 341. **No drift.**
- `input[placeholder="Search tasks or run a command..."]` — still present in `search-modal.tsx` line 311. **No drift.**
- `[data-sprint-task-id]` and `[data-sprint-status-id]` — confirmed present in sprint view. **No drift.**

**No legacy selector drift found.** All failures are caused by behavioral changes (timing, layout, focus), not by changed/removed attribute selectors.

## Recommended Fix Order

| Priority | Fix | Effort | Confidence |
|----------|-----|--------|------------|
| P0 | Add result-button wait in `addTaskLink` | 1 line | high |
| P0 | Add `exact: true` to preset button selector | 1 line | high |
| P1 | Fix drag coordinates (replace hardcoded offsets) | 5 lines | medium |
| P1 | Investigate Dialog reconciliation during typing | 2-10 lines | medium |
| P2 | Add retry/verify in bulk action test | 3 lines | low |

## Next steps

1. Run targeted test to confirm link search failure timing hypothesis
2. Add `page.pause()` or trace capture to observe Dialog close/reopen during quick-add typing
3. Verify bulk action test with manual debug of tRPC cache state
