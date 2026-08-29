-- Webhook delivery claim-owner token (lease safety):
--  - `claimToken` is a random owner token minted on every
--    pending -> processing claim. Every success/failure/requeue update must
--    present the SAME token (`where id AND status = processing AND
--    claimToken = ours`), so a worker whose lease expired and was re-claimed
--    by another worker (lease recovery) can never finalize or reschedule the
--    new claim. Cleared whenever the row leaves `processing`; recovery clears
--    it together with the expired lease, and the next claim mints a new one.

ALTER TABLE "WebhookDelivery" ADD COLUMN "claimToken" TEXT;