-- Webhook delivery exclusive claim + resource caps:
--  - new `processing` status so a delivery is claimed exactly once
--    (pending -> processing is an atomic updateMany; only the claimer
--    finalizes the row)
--  - `leaseExpiresAt` carries the claim lease; expired leases are
--    deliberately recovered back to `pending` by the scheduler sweep

ALTER TYPE "WebhookDeliveryStatus" ADD VALUE IF NOT EXISTS 'processing' AFTER 'pending';

ALTER TABLE "WebhookDelivery" ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);