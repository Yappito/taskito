-- AiConversation.providerId becomes optional so deleting a provider does not
-- violate the foreign key; conversations keep their history with providerId NULL.
ALTER TABLE "AiConversation" DROP CONSTRAINT "AiConversation_providerId_fkey";

ALTER TABLE "AiConversation" ALTER COLUMN "providerId" DROP NOT NULL;

ALTER TABLE "AiConversation" ADD CONSTRAINT "AiConversation_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "AiProviderConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
