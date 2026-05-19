import { describe, expect, it } from "vitest";

import {
  DEFAULT_TASK_DETAIL_SECTION_ORDER,
  moveTaskDetailSectionOrder,
  normalizeTaskDetailSectionOrder,
} from "../task-detail-section-order";

describe("task detail section order", () => {
  it("normalizes stored order values by removing invalid ids and appending missing sections", () => {
    expect(normalizeTaskDetailSectionOrder(["comments", "invalid", "comments", "record"]))
      .toEqual([
        "comments",
        "record",
        ...DEFAULT_TASK_DETAIL_SECTION_ORDER.filter((sectionId) => !["comments", "record"].includes(sectionId)),
      ]);
  });

  it("moves sections before or after another section", () => {
    expect(moveTaskDetailSectionOrder(DEFAULT_TASK_DETAIL_SECTION_ORDER, "description", "comments", "after"))
      .toEqual([
        "timeTracking",
        "recurrence",
        "dependencyWarning",
        "overview",
        "participants",
        "comments",
        "description",
        "details",
        "alert",
        "dependencies",
        "activity",
        "record",
      ]);

    expect(moveTaskDetailSectionOrder(DEFAULT_TASK_DETAIL_SECTION_ORDER, "record", "timeTracking", "before"))
      .toEqual([
        "record",
        "timeTracking",
        "recurrence",
        "dependencyWarning",
        "overview",
        "participants",
        "description",
        "comments",
        "details",
        "alert",
        "dependencies",
        "activity",
      ]);
  });
});
