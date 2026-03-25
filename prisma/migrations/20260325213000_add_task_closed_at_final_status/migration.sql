ALTER TABLE "WorkflowStatus"
ADD COLUMN "isFinal" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Task"
ADD COLUMN "closedAt" TIMESTAMP(3);

WITH ranked_done_statuses AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "order" ASC, id ASC) AS rank_in_project
  FROM "WorkflowStatus"
  WHERE category = 'done'
)
UPDATE "WorkflowStatus" AS status
SET "isFinal" = true
FROM ranked_done_statuses
WHERE status.id = ranked_done_statuses.id
  AND ranked_done_statuses.rank_in_project = 1;

UPDATE "Task" AS task
SET "closedAt" = task."updatedAt"
FROM "WorkflowStatus" AS status
WHERE task."statusId" = status.id
  AND status."isFinal" = true
  AND task."closedAt" IS NULL;