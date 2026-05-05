CREATE TYPE "AiRollbackStatus" AS ENUM ('unavailable', 'available', 'rolledBack', 'failed');

ALTER TABLE "AiActionExecution"
ADD COLUMN "checkpointBefore" JSONB,
ADD COLUMN "checkpointAfter" JSONB,
ADD COLUMN "rollbackStatus" "AiRollbackStatus" NOT NULL DEFAULT 'unavailable',
ADD COLUMN "rollbackErrorMessage" TEXT,
ADD COLUMN "rolledBackAt" TIMESTAMP(3),
ADD COLUMN "rolledBackByUserId" TEXT;

ALTER TABLE "AiActionExecution"
ADD CONSTRAINT "AiActionExecution_rolledBackByUserId_fkey"
FOREIGN KEY ("rolledBackByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "AiActionExecution_rolledBackByUserId_createdAt_idx" ON "AiActionExecution"("rolledBackByUserId", "createdAt");
