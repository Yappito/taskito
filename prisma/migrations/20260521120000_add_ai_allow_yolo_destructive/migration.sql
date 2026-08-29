-- Allow Yolo mode to auto-execute destructive AI actions (archive, bulk update,
-- create, duplicate, remove link). Defaults to false so yolo mode only runs
-- non-destructive actions until a project admin opts in.
ALTER TABLE "AiProjectPolicy" ADD COLUMN "allowYoloDestructive" BOOLEAN NOT NULL DEFAULT false;