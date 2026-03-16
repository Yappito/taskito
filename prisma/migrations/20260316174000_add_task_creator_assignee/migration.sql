ALTER TABLE "Task"
ADD COLUMN "creatorId" TEXT,
ADD COLUMN "assigneeId" TEXT;

ALTER TABLE "Task"
ADD CONSTRAINT "Task_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Task"
ADD CONSTRAINT "Task_assigneeId_fkey"
FOREIGN KEY ("assigneeId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Task_projectId_assigneeId_idx" ON "Task"("projectId", "assigneeId");
CREATE INDEX "Task_creatorId_idx" ON "Task"("creatorId");