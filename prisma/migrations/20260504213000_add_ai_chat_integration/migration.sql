-- CreateEnum
CREATE TYPE "AiProviderScope" AS ENUM ('user', 'project');

-- CreateEnum
CREATE TYPE "AiProviderAdapter" AS ENUM ('openai_compatible', 'anthropic');

-- CreateEnum
CREATE TYPE "AiConversationMode" AS ENUM ('approval', 'yolo');

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('system', 'user', 'assistant', 'tool');

-- CreateEnum
CREATE TYPE "AiActionStatus" AS ENUM ('proposed', 'approved', 'rejected', 'executed', 'failed');

-- CreateEnum
CREATE TYPE "AiActionType" AS ENUM ('addComment', 'addLink', 'removeLink', 'moveStatus', 'assignTask', 'editTask', 'bulkUpdate', 'createTask', 'duplicateTask', 'archiveTask', 'unarchiveTask');

-- CreateTable
CREATE TABLE "AiProviderConnection" (
    "id" TEXT NOT NULL,
    "scope" "AiProviderScope" NOT NULL,
    "ownerUserId" TEXT,
    "projectId" TEXT,
    "label" TEXT NOT NULL,
    "adapter" "AiProviderAdapter" NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "defaultHeaders" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProjectPolicy" (
    "projectId" TEXT NOT NULL,
    "defaultProviderId" TEXT,
    "allowUserProviders" BOOLEAN NOT NULL DEFAULT true,
    "allowProjectProviders" BOOLEAN NOT NULL DEFAULT true,
    "allowYoloMode" BOOLEAN NOT NULL DEFAULT false,
    "defaultPermissions" JSONB NOT NULL DEFAULT '[]',
    "maxPermissions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProjectPolicy_pkey" PRIMARY KEY ("projectId")
);

-- CreateTable
CREATE TABLE "AiConversation" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "mode" "AiConversationMode" NOT NULL DEFAULT 'approval',
    "title" TEXT,
    "grantedPermissions" JSONB NOT NULL DEFAULT '[]',
    "selectedTaskIds" JSONB,
    "contextSnapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "toolName" TEXT,
    "toolPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiActionExecution" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT,
    "projectId" TEXT NOT NULL,
    "taskId" TEXT,
    "requestedByUserId" TEXT NOT NULL,
    "executedByUserId" TEXT,
    "actionType" "AiActionType" NOT NULL,
    "mode" "AiConversationMode" NOT NULL,
    "status" "AiActionStatus" NOT NULL DEFAULT 'proposed',
    "proposedPayload" JSONB NOT NULL,
    "executedPayload" JSONB,
    "result" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiProviderConnection_ownerUserId_idx" ON "AiProviderConnection"("ownerUserId");

-- CreateIndex
CREATE INDEX "AiProviderConnection_projectId_idx" ON "AiProviderConnection"("projectId");

-- CreateIndex
CREATE INDEX "AiConversation_projectId_updatedAt_idx" ON "AiConversation"("projectId", "updatedAt");

-- CreateIndex
CREATE INDEX "AiConversation_taskId_idx" ON "AiConversation"("taskId");

-- CreateIndex
CREATE INDEX "AiConversation_createdByUserId_updatedAt_idx" ON "AiConversation"("createdByUserId", "updatedAt");

-- CreateIndex
CREATE INDEX "AiMessage_conversationId_createdAt_idx" ON "AiMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiActionExecution_conversationId_createdAt_idx" ON "AiActionExecution"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AiActionExecution_projectId_createdAt_idx" ON "AiActionExecution"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AiActionExecution_taskId_createdAt_idx" ON "AiActionExecution"("taskId", "createdAt");

-- CreateIndex
CREATE INDEX "AiActionExecution_requestedByUserId_createdAt_idx" ON "AiActionExecution"("requestedByUserId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiProviderConnection" ADD CONSTRAINT "AiProviderConnection_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProviderConnection" ADD CONSTRAINT "AiProviderConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProjectPolicy" ADD CONSTRAINT "AiProjectPolicy_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProjectPolicy" ADD CONSTRAINT "AiProjectPolicy_defaultProviderId_fkey" FOREIGN KEY ("defaultProviderId") REFERENCES "AiProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProviderConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiMessage" ADD CONSTRAINT "AiMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActionExecution" ADD CONSTRAINT "AiActionExecution_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AiConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActionExecution" ADD CONSTRAINT "AiActionExecution_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "AiMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActionExecution" ADD CONSTRAINT "AiActionExecution_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActionExecution" ADD CONSTRAINT "AiActionExecution_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActionExecution" ADD CONSTRAINT "AiActionExecution_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiActionExecution" ADD CONSTRAINT "AiActionExecution_executedByUserId_fkey" FOREIGN KEY ("executedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
