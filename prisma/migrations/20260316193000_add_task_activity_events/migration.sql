CREATE TYPE "TaskActivityAction" AS ENUM (
  'created',
  'updated',
  'bulkUpdated',
  'commented',
  'archived',
  'unarchived',
  'duplicated'
);

CREATE TABLE "ActivityEvent" (
  "id" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "actorId" TEXT,
  "action" "TaskActivityAction" NOT NULL,
  "details" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ActivityEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActivityEvent_taskId_createdAt_idx" ON "ActivityEvent"("taskId", "createdAt");
CREATE INDEX "ActivityEvent_actorId_idx" ON "ActivityEvent"("actorId");

ALTER TABLE "ActivityEvent"
ADD CONSTRAINT "ActivityEvent_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "Task"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ActivityEvent"
ADD CONSTRAINT "ActivityEvent_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;