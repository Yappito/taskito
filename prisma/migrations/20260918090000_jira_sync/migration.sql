-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "externalAuthor" TEXT,
ADD COLUMN     "jiraAttemptAt" TIMESTAMP(3),
ADD COLUMN     "jiraCommentId" TEXT,
ADD COLUMN     "jiraSyncError" TEXT,
ADD COLUMN     "jiraSyncState" TEXT,
ADD COLUMN     "visibility" TEXT NOT NULL DEFAULT 'internal';

-- AlterTable
ALTER TABLE "CommentAttachment" ADD COLUMN     "jiraAttachmentId" TEXT;

-- CreateTable
CREATE TABLE "JiraConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "encryptedApiToken" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "participantFieldId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalMinutes" INTEGER NOT NULL DEFAULT 5,
    "defaultDueDays" INTEGER NOT NULL DEFAULT 7,
    "statusMapping" JSONB NOT NULL DEFAULT '{}',
    "lastSyncedAt" TIMESTAMP(3),
    "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JiraConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JiraIssue" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "issueId" TEXT,
    "issueKey" TEXT,
    "serviceDeskId" TEXT,
    "requestTypeId" TEXT,
    "jiraProjectKey" TEXT,
    "jiraProjectName" TEXT,
    "issueTypeId" TEXT,
    "outboundFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "outboundStatus" BOOLEAN NOT NULL DEFAULT false,
    "outboundUserId" TEXT,
    "outboundVersion" INTEGER NOT NULL DEFAULT 0,
    "sentVersion" INTEGER NOT NULL DEFAULT 0,
    "syncState" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "attemptAt" TIMESTAMP(3),
    "remoteUpdatedAt" TIMESTAMP(3),
    "history" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "JiraIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JiraConnection_userId_key" ON "JiraConnection"("userId");

-- CreateIndex
CREATE INDEX "JiraConnection_enabled_nextSyncAt_idx" ON "JiraConnection"("enabled", "nextSyncAt");

-- CreateIndex
CREATE UNIQUE INDEX "JiraIssue_taskId_key" ON "JiraIssue"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "JiraIssue_connectionId_issueId_key" ON "JiraIssue"("connectionId", "issueId");

-- CreateIndex
CREATE UNIQUE INDEX "Comment_taskId_jiraCommentId_key" ON "Comment"("taskId", "jiraCommentId");

-- CreateIndex
CREATE UNIQUE INDEX "CommentAttachment_commentId_jiraAttachmentId_key" ON "CommentAttachment"("commentId", "jiraAttachmentId");

-- AddForeignKey
ALTER TABLE "JiraConnection" ADD CONSTRAINT "JiraConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraConnection" ADD CONSTRAINT "JiraConnection_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraIssue" ADD CONSTRAINT "JiraIssue_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JiraIssue" ADD CONSTRAINT "JiraIssue_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "JiraConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
