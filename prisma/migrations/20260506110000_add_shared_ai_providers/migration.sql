ALTER TYPE "AiProviderScope" ADD VALUE 'shared';

ALTER TABLE "AiProjectPolicy"
ADD COLUMN "allowSharedProviders" BOOLEAN NOT NULL DEFAULT true;
