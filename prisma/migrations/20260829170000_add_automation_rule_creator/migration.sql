-- Automation rules now remember who created them so scheduled executions run
-- as the creator (after re-checking their permissions), never as the project
-- owner — see "AutomationRule.createdByUserId".
ALTER TABLE "AutomationRule" ADD COLUMN "createdByUserId" TEXT;

CREATE INDEX "AutomationRule_createdByUserId_idx" ON "AutomationRule"("createdByUserId");

ALTER TABLE "AutomationRule"
  ADD CONSTRAINT "AutomationRule_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;