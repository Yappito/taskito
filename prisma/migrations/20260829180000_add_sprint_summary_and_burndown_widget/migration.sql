-- Sprint lifecycle fields: startedAt / completedAt timestamps and the
-- completion summary snapshot ({ committedCount, completedCount,
-- carriedOverCount, completedTaskIds }).
ALTER TABLE "Sprint" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Sprint" ADD COLUMN "completedAt" TIMESTAMP(3);
ALTER TABLE "Sprint" ADD COLUMN "summary" JSONB;

-- Burndown dashboard widget type.
ALTER TYPE "DashboardWidgetType" ADD VALUE IF NOT EXISTS 'burndown';