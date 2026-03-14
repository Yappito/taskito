-- Add role column to User with default
ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'member';

-- Add key column to Project (nullable first, then populate, then make required)
ALTER TABLE "Project" ADD COLUMN "key" TEXT;
UPDATE "Project" SET "key" = UPPER(LEFT(REPLACE("slug", '-', ''), 3)) WHERE "key" IS NULL;
ALTER TABLE "Project" ALTER COLUMN "key" SET NOT NULL;
CREATE UNIQUE INDEX "Project_key_key" ON "Project"("key");

-- Add taskNumber column to Task (nullable first, then populate, then make required)
ALTER TABLE "Task" ADD COLUMN "taskNumber" INTEGER;

-- Assign sequential task numbers per project ordered by createdAt
UPDATE "Task" AS t
SET "taskNumber" = sub.rn
FROM (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt" ASC) AS rn
  FROM "Task"
) AS sub
WHERE t."id" = sub."id";

ALTER TABLE "Task" ALTER COLUMN "taskNumber" SET NOT NULL;

-- Add unique constraint on (projectId, taskNumber)
CREATE UNIQUE INDEX "Task_projectId_taskNumber_key" ON "Task"("projectId", "taskNumber");
