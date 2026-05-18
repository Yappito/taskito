---
agent: debugger
created: 2026-05-18
scope: e2e test, child-dependency validation
type: root-cause
confidence: high
---

# Child dependency E2E tests fail because "Design database schema" is already in terminal status "Done"

## Summary

Two Playwright tests in `e2e/backlog-coverage.spec.ts` fail because they use the seed task **"Design database schema"** as the child in a parent/child dependency, but that task has status **"Done"** (terminal category `done`). The server-side guard in `getDependencyState` (in `src/server/routers/task.ts`) correctly skips children in terminal status, so no error is thrown and the tests time out waiting for an error message that never appears.

## Evidence

- **`e2e/backlog-coverage.spec.ts` lines 419–453**: Both failing tests link to `"Design database schema"` as the child task.
- **`prisma/seed.ts` lines 161–240**: The seed assigns status by index. "Design database schema" is at index 1, so `statusIdx = 4` → "Done" (terminal category `done`).
- **`src/server/routers/task.ts` lines 252–253**: `isTerminalStatusCategory` considers `"done"` and `"cancelled"` as terminal, skipping those children.
- **`src/server/routers/task.ts` lines 264–271**: `openChildCount` only counts children that are NOT in a terminal status.
- The sibling "blocks" test (line 401) **passes** because it creates a fresh blocker task with `"To Do"` status — its child reference ("Add drag-and-drop to board") happens to be Done but the blocks guard checks the *blocker's* status, not the target's.

## Details

- **Failure chain**: test calls `updateTaskStatusToDoneExpectingError` → server updates status to "Done" → `assertCanEnterTerminalStatus` runs `getDependencyState` → child "Design database schema" has `category: "done"` → filtered out → `openChildCount === 0` → no error → `onSuccess` fires, editing mode ends → test waits for error message that never appears → timeout.
- **Discarded hypotheses**: selector mismatch, timing/race, error message format change, form not reading `dependencyState`, missing status transition definition — none match the evidence.

## Next steps

Fix the tests by creating a fresh child task with a non-terminal status (e.g. "To Do") instead of relying on the seed task "Design database schema". This makes the tests independent of seed data ordering.
