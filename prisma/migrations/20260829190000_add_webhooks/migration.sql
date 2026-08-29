-- Outbound webhooks (project-scoped, HMAC-signed, retried) + delivery log

CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('pending', 'success', 'failed');

CREATE TABLE "Webhook" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "encryptedSecret" TEXT NOT NULL,
  "events" TEXT[] NOT NULL,
  "isEnabled" BOOLEAN NOT NULL DEFAULT true,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
  "id" TEXT NOT NULL,
  "webhookId" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'pending',
  "responseCode" INTEGER,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Webhook_projectId_isEnabled_idx" ON "Webhook"("projectId", "isEnabled");

CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");

CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;