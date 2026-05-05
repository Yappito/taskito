-- New projects should expose all AI permissions by default while keeping read-only as the default selected set.
ALTER TABLE "AiProjectPolicy"
ALTER COLUMN "allowYoloMode" SET DEFAULT TRUE,
ALTER COLUMN "maxPermissions" SET DEFAULT '["read_current_task","read_selected_tasks","search_project","add_comment","link_tasks","move_status","assign_task","edit_core_fields","edit_tags","edit_custom_fields","bulk_update_selected","create_task","duplicate_task","archive_task"]';

-- Existing policies created before the write-permission UI should be opened up unless narrowed again by an owner.
UPDATE "AiProjectPolicy"
SET "allowYoloMode" = TRUE,
    "maxPermissions" = '["read_current_task","read_selected_tasks","search_project","add_comment","link_tasks","move_status","assign_task","edit_core_fields","edit_tags","edit_custom_fields","bulk_update_selected","create_task","duplicate_task","archive_task"]'
WHERE "allowYoloMode" = FALSE
   OR "maxPermissions" = '["read_current_task","read_selected_tasks","search_project"]';
