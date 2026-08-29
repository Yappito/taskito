-- Fires exactly once per (rule, task, due-date occurrence): the UNIQUE
-- (ruleId, taskId, dueDate) constraint is claimed before the automation action
-- runs, so a `dueDatePassed` rule cannot re-fire on every scheduler tick while
-- a task stays overdue.
CREATE TABLE "AutomationRuleFiring" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationRuleFiring_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AutomationRuleFiring_ruleId_taskId_dueDate_key" ON "AutomationRuleFiring"("ruleId", "taskId", "dueDate");
CREATE INDEX "AutomationRuleFiring_taskId_idx" ON "AutomationRuleFiring"("taskId");
CREATE INDEX "AutomationRuleFiring_dueDate_idx" ON "AutomationRuleFiring"("dueDate");

ALTER TABLE "AutomationRuleFiring"
  ADD CONSTRAINT "AutomationRuleFiring_ruleId_fkey"
  FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AutomationRuleFiring"
  ADD CONSTRAINT "AutomationRuleFiring_taskId_fkey"
  FOREIGN KEY ("taskId") REFERENCES "Task"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;