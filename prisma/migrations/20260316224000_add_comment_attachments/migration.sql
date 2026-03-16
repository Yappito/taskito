CREATE TABLE "CommentAttachment" (
  "id" TEXT NOT NULL,
  "commentId" TEXT NOT NULL,
  "originalName" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "sizeBytes" INTEGER NOT NULL,
  "storagePath" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "CommentAttachment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CommentAttachment_commentId_createdAt_idx" ON "CommentAttachment"("commentId", "createdAt");

ALTER TABLE "CommentAttachment"
ADD CONSTRAINT "CommentAttachment_commentId_fkey"
FOREIGN KEY ("commentId") REFERENCES "Comment"("id")
ON DELETE CASCADE ON UPDATE CASCADE;