# Phase 2: Recurrence correctness (atomicity + dayOfWeek/dayOfMonth)

## Context

Critical B3 and high B4 from `docs/taskito-fixes-plan/00-overview.md`. The recurrence
processor creates tasks and advances `nextDueDate` in two separate writes inside a
swallowed `catch {}` — a failure between them re-creates the same task every cron
tick. Also `dayOfWeek`/`dayOfMonth` are accepted by the router and stored in the
schema but never applied by the processor.

## Scope (files you may touch)

- `src/server/services/recurrence-processor.ts`
- `src/server/routers/recurrence.ts` (only if you need to read semantics; no behavior change)
- `src/lib/date-utils.ts` (only if a shared helper is needed; otherwise keep helpers local)
- New test: `src/server/services/__tests__/recurrence-processor.test.ts`
- `docs/taskito-fixes-plan/STATUS.md`

## Tasks

### T2.1 — Atomic per-rule processing
In `src/server/services/recurrence-processor.ts` (`processDueRecurrences`, line 17):
- Wrap each rule's work in `prisma.$transaction(async (tx) => { ... })` so task
  creation AND `nextDueDate` advance commit or roll back together.
- Inside the transaction use `createTaskWithNextNumber(tx, ...)` (the factory already
  accepts a transaction client) and `tx.recurrenceRule.update(...)`.
- The `endDate` early-continue path (`rule.endDate && nextDueDate > rule.endDate`,
  line 42) should also advance `nextDueDate` inside a transaction (or keep it a plain
  update — it's a single write; but it must NOT be skipped, and must not leave the
  rule due forever).
- Replace the swallowed `catch {}` (line 80): log the error with
  `console.error("Recurrence rule processing failed", { ruleId: rule.id, error })`
  and continue with the next rule. Keep the "one bad rule does not block the batch"
  behavior, but make failures visible.
- Optionally return `failedRuleIds` in the result object (additive, safe).

### T2.2 — Apply dayOfWeek / dayOfMonth
`prisma/schema.prisma` RecurrenceRule has `dayOfWeek Int?` (0-6, Sunday=0) and
`dayOfMonth Int?` (1-31). Router `recurrence.ts` accepts them (lines 17-18, 46-47, 54-55).
The processor currently ignores them. Implement:
- If `rule.dayOfWeek != null` and `rule.frequency === "weekly"`: next due date = the
  next occurrence of that weekday at-or-after `addInterval(rule.nextDueDate, ...)`.
  (Keep interval semantics: advance by interval weeks from nextDueDate, then snap to
  the configured weekday if the result isn't already it.)
- If `rule.dayOfMonth != null` and `rule.frequency === "monthly"`: next due date =
  that day-of-month of the month produced by `addInterval`. Clamp to last day of
  month when dayOfMonth exceeds it (e.g. Feb 31 → Feb 28/29). Avoid double-advancing:
  the created task's `dueDate` stays `rule.nextDueDate` (as today); only the new
  `nextDueDate` respects the weekday/day-of-month rule.
- If neither is set: current `addInterval` behavior (unchanged).
- Keep `addInterval` behavior for daily/yearly regardless of dayOfWeek/dayOfMonth.
- Edge: if the computed next due date equals or precedes `rule.nextDueDate` (e.g.
  clamping), advance at least one interval to guarantee progress and prevent a
  hot loop on every cron tick.

### T2.3 — Tests
New `src/server/services/__tests__/recurrence-processor.test.ts` covering:
- Atomicity: when the task-create step throws inside the transaction, the rule's
  `nextDueDate` is NOT advanced (rollback). Use a mocked transaction client or a
  real `$transaction` stub.
- Success path: task created, `nextDueDate` advanced, activity event fired.
- dayOfWeek weekly snapping (e.g. rule due on a Monday, dayOfWeek=3 → next Wednesday).
- dayOfMonth monthly with clamping (e.g. dayOfMonth=31 in a 30-day month).
- endDate boundary: when next due > endDate, no task is created and nextDueDate is
  advanced past the endDate (or rule effectively completes).
- One failing rule does not block others; failure is logged.

## Definition of done

1. Per-rule transaction: create + advance atomic.
2. Errors logged, batch continues.
3. `dayOfWeek` (weekly) and `dayOfMonth` (monthly) applied with clamping and progress guarantee.
4. New tests cover the cases in T2.3.
5. `npm test` (all), `npx tsc --noEmit`, `npm run build` all pass.
