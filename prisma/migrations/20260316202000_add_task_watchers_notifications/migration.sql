CREATE TYPE "NotificationType" AS ENUM (
  'assigned',
  'commented',
  'statusChanged',
  'mentioned'
);

CREATE TABLE "TaskWatcher" (
  "taskId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "TaskWatcher_pkey" PRIMARY KEY ("taskId", "userId")
);

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "actorId" TEXT,
  "taskId" TEXT,
  "type" "NotificationType" NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}',
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TaskWatcher_userId_idx" ON "TaskWatcher"("userId");
CREATE INDEX "Notification_recipientId_createdAt_idx" ON "Notification"("recipientId", "createdAt");
CREATE INDEX "Notification_taskId_idx" ON "Notification"("taskId");

ALTER TABLE "TaskWatcher"
ADD CONSTRAINT "TaskWatcher_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "Task"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TaskWatcher"
ADD CONSTRAINT "TaskWatcher_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_recipientId_fkey"
FOREIGN KEY ("recipientId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_actorId_fkey"
FOREIGN KEY ("actorId") REFERENCES "User"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Notification"
ADD CONSTRAINT "Notification_taskId_fkey"
FOREIGN KEY ("taskId") REFERENCES "Task"("id")
ON DELETE CASCADE ON UPDATE CASCADE;