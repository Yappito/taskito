# Phase 2 Deviations

## Task creation inside the per-rule transaction does not use `createTaskWithNextNumber`

Spec (T2.1): "Inside the transaction use `createTaskWithNextNumber(tx, ...)` (the
factory already accepts a transaction client)."

This is not implementable as written:

- Prisma 6.6.0's interactive transaction client denies `$transaction` at runtime.
  The installed runtime strips `$connect`, `$disconnect`, `$on`, `$transaction`,
  `$extends` from the ITX client proxy
  (`node_modules/@prisma/client/runtime/client.js`: `Ym = ["$connect","$disconnect","$on","$transaction","$extends"]`),
  so `createTaskWithNextNumber(tx, ...)` would throw
  `TypeError: tx.$transaction is not a function` on every rule.
- The TS type agrees: `Prisma.TransactionClient = Omit<DefaultPrismaClient, ITXClientDenyList>`
  omits `$transaction`, so the literal call is a `tsc --noEmit` error without a
  cast (repo bans `any` / `@ts-ignore` / `@ts-expect-error`).

Implementation instead: the per-rule `prisma.$transaction` allocates the task
number inline (`tx.task.findFirst` by `taskNumber desc`, then create, mirroring
`getNextTaskNumber`/`createTaskWithNextNumber` semantics) and retries the WHOLE
per-rule transaction on a P2002 `(projectId, taskNumber)` conflict (5 attempts,
matching `createTaskWithNextNumber`'s default). This preserves the required
semantics — create + `nextDueDate` advance commit or roll back together, retry on
conflict, unrelated failures propagate — and works with real Prisma (Postgres
aborts the failed transaction, so a conflict retry must start a fresh transaction
anyway).

## Result object extended with `failedRuleIds`

Spec: "Optionally return `failedRuleIds` in the result object (additive, safe)."
Added: `{ processed, createdTaskIds, failedRuleIds }`. Additive; the cron route
and tRPC `processDue` serialize the extra field without behavior change.

## Test changes

- No existing test was deleted, skipped, or weakened; no existing assertions were
  changed. New file only:
  `src/server/services/__tests__/recurrence-processor.test.ts` (7 tests).

## Note (not a deviation)

Test dates were chosen to stay within a single DST regime (May–June, Jan–Feb)
because `addInterval` performs local-time arithmetic and a date crossing the
Europe DST transition shifts the UTC hour — pre-existing behavior, not changed.
