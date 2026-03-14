-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "body" TEXT;

-- AlterTable
ALTER TABLE "WorkflowStatus" ADD COLUMN     "autoArchive" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Task_projectId_archivedAt_idx" ON "Task"("projectId", "archivedAt");
