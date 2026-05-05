-- Store user-facing proposal metadata separately from executable payloads.
ALTER TABLE "AiActionExecution"
ADD COLUMN "title" TEXT,
ADD COLUMN "summary" TEXT;

ALTER TABLE "AiProjectPolicy"
ALTER COLUMN "defaultPermissions" SET DEFAULT '["read_current_task","read_selected_tasks","search_project"]',
ALTER COLUMN "maxPermissions" SET DEFAULT '["read_current_task","read_selected_tasks","search_project"]';
