-- Automation attribution fix (finding 4): scheduled executions of an
-- automation rule must be attributed to the user who LAST edited the rule
-- (the execution principal), never to the original creator — a second editor
-- can otherwise rewrite a rule into generating content that appears to be
-- authored by someone else.
ALTER TABLE "AutomationRule" ADD COLUMN "lastEditedByUserId" TEXT;

-- Existing rules keep their creator as the execution principal until the
-- first edit backfills the column.
UPDATE "AutomationRule" SET "lastEditedByUserId" = "createdByUserId" WHERE "createdByUserId" IS NOT NULL;

CREATE INDEX "AutomationRule_lastEditedByUserId_idx" ON "AutomationRule"("lastEditedByUserId");

ALTER TABLE "AutomationRule"
  ADD CONSTRAINT "AutomationRule_lastEditedByUserId_fkey"
  FOREIGN KEY ("lastEditedByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;