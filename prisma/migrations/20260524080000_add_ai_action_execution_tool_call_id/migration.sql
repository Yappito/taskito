-- Store the native provider tool-call id on AI action executions so the
-- tool-result loop can write role:"tool" AiMessage rows that reference
-- (and replay against) the assistant message's toolCalls entries.
ALTER TABLE "AiActionExecution" ADD COLUMN "toolCallId" TEXT;