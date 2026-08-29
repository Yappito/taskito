-- CITADEL-e10 (finding 6): intermediate "sending" claim state, entered
-- immediately before the SMTP call. SMTP is an external side effect a DB row
-- cannot prove; a claim found stale in "sending" is therefore ambiguous and
-- is abandoned (failed at the attempt cap) rather than resent, so a digest
-- is sent at most once per user per UTC day.

ALTER TYPE "EmailDigestClaimStatus" ADD VALUE 'sending';
