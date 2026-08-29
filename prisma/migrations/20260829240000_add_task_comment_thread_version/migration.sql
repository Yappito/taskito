-- CITADEL-e10 (finding 5): durable comment-thread version for the AI summary
-- cache compare-and-swap. Incremented by every comment create, edit, and
-- delete for the owning task, so the CAS catches in-place comment edits
-- (createdAt unchanged) and deletions of older comments, which the previous
-- newest-createdAt predicate could not observe.

ALTER TABLE "Task" ADD COLUMN "commentThreadVersion" INTEGER NOT NULL DEFAULT 0;
