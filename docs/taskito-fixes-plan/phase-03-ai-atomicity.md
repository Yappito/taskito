# Phase 3: AI action atomicity (checkpoint sprintId + yolo serialization)

## Context

Critical B1 and highs B7/B8 from `docs/taskito-fixes-plan/00-overview.md`. The AI
checkpoint snapshot/restore omits `sprintId` (verified: zero mentions in
`src/server/services/ai/checkpoints.ts`), so rollback silently loses sprint
assignment. Yolo mode executes proposals via `Promise.all` with no serialization,
and checkpoint capture vs. action execution is not transactional.

## Scope (files you may touch)

- `src/server/services/ai/checkpoints.ts`
- `src/server/services/ai/orchestrator.ts`
- `src/server/services/ai/action-executor.ts` (only if needed for transaction shape)
- Tests: `src/server/services/ai/__tests__/` (new checkpoint test, orchestrator test)
- `docs/taskito-fixes-plan/STATUS.md`

## Tasks

### T3.1 — sprintId in checkpoint snapshot + restore
In `src/server/services/ai/checkpoints.ts`:
- `serializeTask` (line 82): add `sprintId: task.sprintId ?? null` to the data record.
- `restoreTaskSnapshot` (line 339): add `sprintId: toNullableString(task.data.sprintId)` —
  add a `toNullableString` helper next to the existing `asString`/`toNullableDate`
  helpers (or reuse `asString` + null handling). Restore must set `sprintId` back.
- Keep the `AiActionCheckpoint` interface additive: add `sprintId?: string | null`
  to the TaskSnapshot data type — no field removals (invariants.md).
- If `fetchTaskRows` needs `sprintId` selected: it uses `prisma.task.findMany` with
  `include` — plain `findMany` returns all scalar fields by default, so `sprintId`
  is already in `task` rows. Verify and only adjust if the select excludes it.

### T3.2 — Serialize yolo executions
In `src/server/services/ai/orchestrator.ts` (`persistAiAssistantCompletion`, line 146):
- Replace the `Promise.all(executions.map(...))` block (lines 167-195) with a
  sequential `for...of` loop over `executions` (or `reduce` with awaited chaining).
  Each execution: run `executeAiAction`, update to `executed`, on error update to
  `failed` with message. Order must be deterministic (array order), one at a time.

### T3.3 — Transactional execute + persist
Investigate `executeAiAction` in `src/server/services/ai/action-executor.ts` and the
orchestrator's per-execution update. Ensure:
- The checkpoint is captured BEFORE the action executes (current behavior — verify).
- The execution row update (`status: "executed"` + result) and the action's own DB
  writes happen in ONE transaction when the executor supports it. If
  `executeAiAction` accepts a transaction client, pass `tx`; if not, wrap the
  executor call + status update in `prisma.$transaction` and refactor the executor
  to accept a client parameter (keep its exported signature backward compatible or
  update the single caller — check all callers first).
- If a full transaction isn't feasible without a large refactor, at minimum:
  capture checkpoint, execute, then update status — and on update failure mark the
  execution `failed` with the error so no execution is left dangling as `approved`.
  Document the residual risk in the phase deviations file.
- Yolo non-rollbackable case (B8): after a successful execution, if persisting the
  result fails, the execution must not stay `approved` (mark `failed`).

### T3.4 — Tests
- New `src/server/services/ai/__tests__/checkpoints.test.ts`:
  - serializeTask round-trip includes `sprintId`.
  - restore writes `sprintId` back to the task (mock tx client).
  - rollback of a created task still works.
- New `src/server/services/ai/__tests__/orchestrator-yolo.test.ts`:
  - yolo mode executes proposals sequentially (assert call order via a mock
    `executeAiAction` that records invocation timestamps/order).
  - one failing execution marks only that one `failed`, others still execute.
  - execution status update failure marks the execution `failed`.

## Definition of done

1. Checkpoint snapshot + restore include `sprintId`.
2. Yolo executions run sequentially, deterministically.
3. Execute + persist are transactional (or the documented minimal fallback with
   `failed` status on persist failure is in place).
4. Tests in T3.4 pass.
5. `npm test` (all), `npx tsc --noEmit`, `npm run build` all pass.
