-- CreateEnum
CREATE TYPE "SprintStatus" AS ENUM ('planning', 'active', 'completed');

-- CreateEnum
CREATE TYPE "RecurrenceFrequency" AS ENUM ('daily', 'weekly', 'monthly', 'yearly');

-- CreateEnum
CREATE TYPE "AutomationTrigger" AS ENUM ('taskCreated', 'statusChanged', 'taskAssigned', 'commentAdded', 'dueDatePassed');

-- CreateEnum
CREATE TYPE "AutomationAction" AS ENUM ('moveStatus', 'assignTask', 'addTag', 'removeTag', 'addComment', 'archiveTask', 'unarchiveTask');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('success', 'failed', 'skipped');

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "sprintId" TEXT;

-- AlterTable
ALTER TABLE "AiConversation" ADD COLUMN "streamToken" TEXT;

-- AlterTable
ALTER TABLE "AiMessage" ADD COLUMN "toolCalls" JSONB,
ADD COLUMN "toolCallId" TEXT,
ADD COLUMN "isStreaming" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Sprint" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "status" "SprintStatus" NOT NULL DEFAULT 'planning',
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Sprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TimeLog" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "description" TEXT,
    "duration" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TimeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecurrenceRule" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "frequency" "RecurrenceFrequency" NOT NULL,
    "interval" INTEGER NOT NULL DEFAULT 1,
    "dayOfWeek" INTEGER,
    "dayOfMonth" INTEGER,
    "endDate" TIMESTAMP(3),
    "nextDueDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecurrenceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" "AutomationTrigger" NOT NULL,
    "triggerCondition" JSONB,
    "action" "AutomationAction" NOT NULL,
    "actionPayload" JSONB NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "trigger" "AutomationTrigger" NOT NULL,
    "status" "AutomationRunStatus" NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sprint_projectId_name_key" ON "Sprint"("projectId", "name");

-- CreateIndex
CREATE INDEX "Sprint_projectId_order_idx" ON "Sprint"("projectId", "order");

-- CreateIndex
CREATE INDEX "Sprint_projectId_status_idx" ON "Sprint"("projectId", "status");

-- CreateIndex
CREATE INDEX "Task_projectId_sprintId_idx" ON "Task"("projectId", "sprintId");

-- CreateIndex
CREATE INDEX "TimeLog_taskId_startedAt_idx" ON "TimeLog"("taskId", "startedAt");

-- CreateIndex
CREATE INDEX "TimeLog_userId_startedAt_idx" ON "TimeLog"("userId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RecurrenceRule_taskId_key" ON "RecurrenceRule"("taskId");

-- CreateIndex
CREATE INDEX "RecurrenceRule_nextDueDate_idx" ON "RecurrenceRule"("nextDueDate");

-- CreateIndex
CREATE INDEX "AutomationRule_projectId_isEnabled_idx" ON "AutomationRule"("projectId", "isEnabled");

-- CreateIndex
CREATE INDEX "AutomationRule_projectId_trigger_idx" ON "AutomationRule"("projectId", "trigger");

-- CreateIndex
CREATE INDEX "AutomationRun_projectId_createdAt_idx" ON "AutomationRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationRun_ruleId_createdAt_idx" ON "AutomationRun"("ruleId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationRun_taskId_createdAt_idx" ON "AutomationRun"("taskId", "createdAt");

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_sprintId_fkey" FOREIGN KEY ("sprintId") REFERENCES "Sprint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeLog" ADD CONSTRAINT "TimeLog_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeLog" ADD CONSTRAINT "TimeLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecurrenceRule" ADD CONSTRAINT "RecurrenceRule_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;
