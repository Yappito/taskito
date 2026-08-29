import { describe, it, expect } from "vitest";
import {
  describeActivityEvent,
  getDependencyMessages,
  getMutationErrorMessage,
  formatBytes,
} from "@/lib/task-format";

describe("describeActivityEvent", () => {
  it("describes simple actions", () => {
    expect(describeActivityEvent({ action: "created" })).toBe("created this task");
    expect(describeActivityEvent({ action: "commented" })).toBe("added a comment");
    expect(describeActivityEvent({ action: "archived" })).toBe("archived this task");
    expect(describeActivityEvent({ action: "unarchived" })).toBe("restored this task");
    expect(describeActivityEvent({ action: "duplicated" })).toBe("created this task by duplicating another one");
    expect(describeActivityEvent({ action: "bulkUpdated" })).toBe("applied a bulk update");
  });

  it("lists changed fields for updates", () => {
    expect(
      describeActivityEvent({ action: "updated", details: { changedFields: ["title", "priority"] } })
    ).toBe("updated title, priority");
    expect(
      describeActivityEvent({ action: "updated", details: { changedFields: [42, null] } })
    ).toBe("updated this task");
    expect(
      describeActivityEvent({ action: "updated", details: { changedFields: [] } })
    ).toBe("updated this task");
    expect(describeActivityEvent({ action: "updated" })).toBe("updated this task");
    expect(describeActivityEvent({ action: "updated", details: null })).toBe("updated this task");
  });

  it("falls back to the raw action for unknown actions", () => {
    expect(describeActivityEvent({ action: "converted" })).toBe("converted");
  });
});

describe("getDependencyMessages", () => {
  it("returns no messages without dependency state", () => {
    expect(getDependencyMessages({})).toEqual([]);
    expect(getDependencyMessages({ dependencyState: { blockingTaskCount: 0, openChildCount: 0 } })).toEqual([]);
    expect(getDependencyMessages({ dependencyState: undefined })).toEqual([]);
  });

  it("uses singular forms for one item", () => {
    expect(
      getDependencyMessages({ dependencyState: { blockingTaskCount: 1, openChildCount: 1 } })
    ).toEqual([
      "Blocked by 1 incomplete prerequisite",
      "1 child task is still open",
    ]);
  });

  it("uses plural forms for multiple items", () => {
    expect(
      getDependencyMessages({ dependencyState: { blockingTaskCount: 3, openChildCount: 2 } })
    ).toEqual([
      "Blocked by 3 incomplete prerequisites",
      "2 child tasks are still open",
    ]);
  });
});

describe("getMutationErrorMessage", () => {
  it("prefers the error message", () => {
    expect(getMutationErrorMessage({ message: "Nope" })).toBe("Nope");
  });

  it("falls back to a default message", () => {
    expect(getMutationErrorMessage(null)).toBe("Unable to save task changes.");
    expect(getMutationErrorMessage({})).toBe("Unable to save task changes.");
    expect(getMutationErrorMessage({ message: "" })).toBe("Unable to save task changes.");
  });
});

describe("formatBytes", () => {
  it("formats bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats kilobytes", () => {
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("2 KB");
  });

  it("formats megabytes with one decimal", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
  });
});