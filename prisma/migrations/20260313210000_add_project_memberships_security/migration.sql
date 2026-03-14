CREATE TYPE "ProjectMemberRole" AS ENUM ('owner', 'member');

CREATE TABLE "ProjectMember" (
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "ProjectMemberRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId", "userId")
);

CREATE INDEX "ProjectMember_userId_idx" ON "ProjectMember"("userId");

ALTER TABLE "ProjectMember"
ADD CONSTRAINT "ProjectMember_projectId_fkey"
FOREIGN KEY ("projectId") REFERENCES "Project"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectMember"
ADD CONSTRAINT "ProjectMember_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "ProjectMember" ("projectId", "userId", "role", "createdAt", "updatedAt")
SELECT "Project"."id", "User"."id", 'owner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Project"
CROSS JOIN "User"
ON CONFLICT ("projectId", "userId") DO NOTHING;