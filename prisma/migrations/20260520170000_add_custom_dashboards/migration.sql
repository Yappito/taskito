CREATE TYPE "DashboardVisibility" AS ENUM ('public', 'restricted');
CREATE TYPE "DashboardWidgetType" AS ENUM ('metric', 'pie', 'bar', 'table');
CREATE TYPE "DashboardWidgetGroupBy" AS ENUM ('status', 'priority', 'assignee', 'tag', 'sprint', 'dueMonth');
CREATE TYPE "DashboardMetric" AS ENUM ('count', 'overdue', 'completed', 'unassigned');

CREATE TABLE "SavedFilter" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "query" TEXT NOT NULL,
  "visibility" "DashboardVisibility" NOT NULL DEFAULT 'public',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SavedFilter_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SavedFilterUserShare" (
  "filterId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SavedFilterUserShare_pkey" PRIMARY KEY ("filterId", "userId")
);

CREATE TABLE "Dashboard" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "visibility" "DashboardVisibility" NOT NULL DEFAULT 'public',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Dashboard_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DashboardUserShare" (
  "dashboardId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DashboardUserShare_pkey" PRIMARY KEY ("dashboardId", "userId")
);

CREATE TABLE "DashboardWidget" (
  "id" TEXT NOT NULL,
  "dashboardId" TEXT NOT NULL,
  "savedFilterId" TEXT,
  "title" TEXT NOT NULL,
  "type" "DashboardWidgetType" NOT NULL,
  "groupBy" "DashboardWidgetGroupBy",
  "metric" "DashboardMetric" NOT NULL DEFAULT 'count',
  "query" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  "width" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DashboardWidget_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SavedFilter_projectId_visibility_idx" ON "SavedFilter"("projectId", "visibility");
CREATE INDEX "SavedFilter_ownerId_updatedAt_idx" ON "SavedFilter"("ownerId", "updatedAt");
CREATE INDEX "SavedFilterUserShare_userId_idx" ON "SavedFilterUserShare"("userId");
CREATE INDEX "Dashboard_projectId_visibility_idx" ON "Dashboard"("projectId", "visibility");
CREATE INDEX "Dashboard_ownerId_updatedAt_idx" ON "Dashboard"("ownerId", "updatedAt");
CREATE INDEX "DashboardUserShare_userId_idx" ON "DashboardUserShare"("userId");
CREATE INDEX "DashboardWidget_dashboardId_order_idx" ON "DashboardWidget"("dashboardId", "order");
CREATE INDEX "DashboardWidget_savedFilterId_idx" ON "DashboardWidget"("savedFilterId");

ALTER TABLE "SavedFilter" ADD CONSTRAINT "SavedFilter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedFilter" ADD CONSTRAINT "SavedFilter_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedFilterUserShare" ADD CONSTRAINT "SavedFilterUserShare_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "SavedFilter"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SavedFilterUserShare" ADD CONSTRAINT "SavedFilterUserShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Dashboard" ADD CONSTRAINT "Dashboard_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardUserShare" ADD CONSTRAINT "DashboardUserShare_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardUserShare" ADD CONSTRAINT "DashboardUserShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_dashboardId_fkey" FOREIGN KEY ("dashboardId") REFERENCES "Dashboard"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DashboardWidget" ADD CONSTRAINT "DashboardWidget_savedFilterId_fkey" FOREIGN KEY ("savedFilterId") REFERENCES "SavedFilter"("id") ON DELETE SET NULL ON UPDATE CASCADE;
