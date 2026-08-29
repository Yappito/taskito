-- Durable per-user, per-UTC-day digest send claims: the uniqueness boundary
-- for the daily due-soon digest (replaces the best-effort lastDigestSentAt
-- settings write) and the retry state for failed recipients.

CREATE TYPE "EmailDigestClaimStatus" AS ENUM ('pending', 'succeeded', 'failed');

CREATE TABLE "EmailDigestClaim" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dayUtc" TEXT NOT NULL,
    "status" "EmailDigestClaimStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailDigestClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailDigestClaim_userId_dayUtc_key" ON "EmailDigestClaim"("userId", "dayUtc");

CREATE INDEX "EmailDigestClaim_dayUtc_status_idx" ON "EmailDigestClaim"("dayUtc", "status");

ALTER TABLE "EmailDigestClaim" ADD CONSTRAINT "EmailDigestClaim_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;