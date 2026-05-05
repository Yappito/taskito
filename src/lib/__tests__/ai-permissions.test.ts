import { describe, expect, it } from "vitest";

import { expandAiPermissionPreset, intersectAiPermissions, normalizeAiPermissions } from "@/lib/ai-permissions";

describe("ai-permissions", () => {
  it("normalizes and deduplicates permission values", () => {
    expect(normalizeAiPermissions(["search_project", "search_project", "invalid", 123])).toEqual(["search_project"]);
  });

  it("expands a preset", () => {
    expect(expandAiPermissionPreset("read_only")).toContain("read_current_task");
  });

  it("intersects permission sets", () => {
    expect(
      intersectAiPermissions(
        ["search_project", "add_comment", "move_status"],
        ["search_project", "move_status"],
        ["search_project", "move_status", "assign_task"]
      )
    ).toEqual(["search_project", "move_status"]);
  });
});
