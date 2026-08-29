-- Recurrence-rule dead-rule retirement (single step):
--  - `retiredAt` is a terminal state: when the rule's CURRENT occurrence is
--    already past its end day, the processor sets `retiredAt` directly
--    instead of advancing `nextDueDate` one interval per tick. A rule left
--    years behind used to drain one interval per tick and could monopolize
--    the due pool (oldest-first selection, 50-100 rules per tick) for hours
--    or days, starving healthy due rules; with the flag it retires in ONE
--    tick and never returns (due selection gates on `retiredAt IS NULL`).
--  - (Re-)saving a recurrence via the router clears the flag, so editing a
--    task's recurrence reactivates it.

ALTER TABLE "RecurrenceRule" ADD COLUMN "retiredAt" TIMESTAMP(3);