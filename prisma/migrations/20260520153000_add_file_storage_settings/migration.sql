CREATE TYPE "StorageProvider" AS ENUM ('local', 's3');

ALTER TABLE "User"
ADD COLUMN "profileImageStorageProvider" "StorageProvider" NOT NULL DEFAULT 'local',
ADD COLUMN "profileImageStorageBucket" TEXT,
ADD COLUMN "profileImageStorageKey" TEXT;

ALTER TABLE "CommentAttachment"
ADD COLUMN "storageProvider" "StorageProvider" NOT NULL DEFAULT 'local',
ADD COLUMN "storageBucket" TEXT,
ADD COLUMN "storageKey" TEXT;

CREATE INDEX "CommentAttachment_storageProvider_idx" ON "CommentAttachment"("storageProvider");

CREATE TABLE "StorageSettings" (
  "id" TEXT NOT NULL,
  "provider" "StorageProvider" NOT NULL DEFAULT 'local',
  "s3Bucket" TEXT,
  "s3Region" TEXT,
  "s3Endpoint" TEXT,
  "s3AccessKeyId" TEXT,
  "encryptedS3SecretAccessKey" TEXT,
  "encryptedS3SessionToken" TEXT,
  "s3ForcePathStyle" BOOLEAN NOT NULL DEFAULT false,
  "s3Prefix" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorageSettings_pkey" PRIMARY KEY ("id")
);
