# Phase 3 Deviations

## Full execute+persist transaction (T3.3) not implementable without a large refactor

Spec (T3.3): "The execution row update (`status: "executed"` + result) and the
action's own DB writes happen in ONE transaction... wrap the executor call +
status update in `prisma.$transaction` and refactor the executor to accept a
client parameter."

This is not implementable as written, for the same reason documented in
`phase-2-deviations.md`:

- The action's DB writes run through `taskRouter` procedures invoked via
  `createCaller` in `action-executor.ts`. Several of those procedures call
  `ctx.prisma.$transaction` internally:
  - `task.update` (`src/server/routers/task.ts:868`) — used by `moveStatus`,
    `assignTask`, `editTask`.
  - `task.bulkUpdate` (`src/server/routers/task.ts:1154`).
  - `createTaskWithNextNumber` (`src/server/routers/task.ts:163`) — used by
    `createTask` and `duplicateTask` — retries a P2002 conflict by opening a
    fresh transaction, which requires `$transaction` on the passed client.
- Prisma 6.6.0's interactive transaction client (ITX) denies `$transaction` at
  runtime (it is in the ITX deny list), so passing a transaction client into
  `executeAiAction` and on to the caller would make `update`/`bulkUpdate`/
  `create`/`duplicate` throw `tx.$transaction is not a function` for every
  yolo/approve execution of those action types.
- Making the routers transaction-client-aware would mean touching
  `src/server/routers/task.ts`, which is outside this phase's scope boundary
  (invariants.md: Phase 3 may touch only checkpoints.ts, orchestrator.ts,
  action-executor.ts and their tests; task.ts is Phase 4 scope, pagination
  only).

Implemented instead (the spec's sanctioned minimal fallback):
- Checkpoint is captured BEFORE the action executes (verified in
  `action-executor.ts`: `captureAiCheckpointBefore` at line 59 runs before the
  action switch at line 78; unchanged).
- Yolo executions run sequentially; each is `try { execute + update executed }`
  so a persist failure of a successful execution lands in the catch and marks
  the execution `failed` — no execution is left dangling as `approved`
  (B8's non-rollbackable case).

Residual risk (documented per spec): the execution-row checkpoint writes and
the `executed` status update are not one atomic DB transaction with the
action's own writes. A process crash between the action's commit and the
`executed` update leaves the row `approved` with both checkpoints persisted;
it can then be re-approved and re-run. Rollback of a partially failed
execution is not automatic — `rollbackStatus` only becomes `available` after
`checkpointAfter` is persisted, and rollback requires both checkpoints.

## TaskSnapshot data type note (not a deviation)

Spec: "add `sprintId?: string | null` to the TaskSnapshot data type".
`TaskSnapshot.data` is an untyped `JsonRecord` (`Record<string, unknown>`), so
the field is carried in the serialized record (`serializeTask` adds
`sprintId: task.sprintId ?? null`). The change is additive to the checkpoint
format; nothing was renamed or removed.

## Test changes

- No existing test was deleted, skipped, or weakened; no existing assertions
  were changed. New files only:
  - `src/server/services/ai/__tests__/checkpoints.test.ts` (5 tests).
  - `src/server/services/ai/__tests__/orchestrator-yolo.test.ts` (3 tests).
