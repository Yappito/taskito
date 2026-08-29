-- Add usage column to AiMessage (nullable JSON holding provider token usage metadata)
ALTER TABLE "AiMessage" ADD COLUMN "usage" JSONB;