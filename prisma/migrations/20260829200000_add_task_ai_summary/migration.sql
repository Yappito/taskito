-- CITADEL-d77.32: cached AI task summary on Task (nullable JSON; see ai.summarizeTask)
ALTER TABLE "Task" ADD COLUMN "aiSummary" JSONB;
