ALTER TABLE "User"
  ADD COLUMN "authSource" TEXT NOT NULL DEFAULT 'local',
  ADD COLUMN "disabledAt" TIMESTAMP(3),
  ADD COLUMN "lastLoginAt" TIMESTAMP(3);

ALTER TYPE "ProjectMemberRole" ADD VALUE IF NOT EXISTS 'viewer';
ALTER TYPE "ProjectMemberRole" ADD VALUE IF NOT EXISTS 'manager';

CREATE TYPE "GroupMemberRole" AS ENUM ('member', 'manager');

CREATE TYPE "ProjectPermission" AS ENUM (
  'project_read',
  'project_manage',
  'project_delete',
  'member_manage',
  'task_read',
  'task_create',
  'task_update',
  'task_delete',
  'task_comment',
  'task_archive',
  'workflow_manage',
  'tag_manage',
  'custom_field_manage',
  'sprint_manage',
  'automation_manage',
  'ai_manage',
  'time_log'
);

CREATE TABLE "Group" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "source" TEXT NOT NULL DEFAULT 'local',
  "oidcProvider" TEXT,
  "externalId" TEXT,
  "isSystem" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GroupMember" (
  "groupId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "role" "GroupMemberRole" NOT NULL DEFAULT 'member',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId", "userId")
);

CREATE TABLE "ProjectGroup" (
  "projectId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "role" "ProjectMemberRole" NOT NULL DEFAULT 'member',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProjectGroup_pkey" PRIMARY KEY ("projectId", "groupId")
);

CREATE TABLE "UserProjectPermissionGrant" (
  "projectId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "permission" "ProjectPermission" NOT NULL,
  "allowed" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UserProjectPermissionGrant_pkey" PRIMARY KEY ("projectId", "userId", "permission")
);

CREATE TABLE "GroupProjectPermissionGrant" (
  "projectId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "permission" "ProjectPermission" NOT NULL,
  "allowed" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GroupProjectPermissionGrant_pkey" PRIMARY KEY ("projectId", "groupId", "permission")
);

CREATE UNIQUE INDEX "Group_slug_key" ON "Group"("slug");
CREATE UNIQUE INDEX "Group_source_oidcProvider_externalId_key" ON "Group"("source", "oidcProvider", "externalId");
CREATE INDEX "Group_source_oidcProvider_idx" ON "Group"("source", "oidcProvider");
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");
CREATE INDEX "ProjectGroup_groupId_idx" ON "ProjectGroup"("groupId");
CREATE INDEX "UserProjectPermissionGrant_userId_idx" ON "UserProjectPermissionGrant"("userId");
CREATE INDEX "GroupProjectPermissionGrant_groupId_idx" ON "GroupProjectPermissionGrant"("groupId");

ALTER TABLE "GroupMember"
  ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ProjectGroup"
  ADD CONSTRAINT "ProjectGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ProjectGroup_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "UserProjectPermissionGrant"
  ADD CONSTRAINT "UserProjectPermissionGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "UserProjectPermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "GroupProjectPermissionGrant"
  ADD CONSTRAINT "GroupProjectPermissionGrant_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "GroupProjectPermissionGrant_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
