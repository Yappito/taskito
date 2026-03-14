-- This migration originally tried to alter ProjectMember before the table
-- existed in the migration timeline. Keep the migration name stable and make
-- this a no-op; the actual default removal now happens after the table is
-- created in a later migration.
SELECT 1;
