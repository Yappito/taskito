import { describe, expect, it } from "vitest";
import {
  boardColumnTruncationNotice,
  firstPageTruncationMessage,
  flattenTaskPages,
  formatShowingCount,
  hasUnloadedTasks,
} from "@/lib/task-pagination";

describe("flattenTaskPages", () => {
  it("returns an empty list for undefined or empty pages", () => {
    expect(flattenTaskPages(undefined)).toEqual([]);
    expect(flattenTaskPages([])).toEqual([]);
    expect(flattenTaskPages([{ items: [] }])).toEqual([]);
  });

  it("concatenates items across pages in page order", () => {
    const pages = [
      { items: [{ id: "a" }, { id: "b" }] },
      { items: [{ id: "c" }] },
    ];
    expect(flattenTaskPages(pages)).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
  });

  it("drops duplicates that appear on a later page, keeping first occurrence", () => {
    const pages = [
      { items: [{ id: "a", n: 1 }, { id: "b" }] },
      { items: [{ id: "a", n: 2 }, { id: "c" }, { id: "a", n: 3 }] },
    ];
    expect(flattenTaskPages(pages)).toEqual([
      { id: "a", n: 1 },
      { id: "b" },
      { id: "c" },
    ]);
  });
});

describe("formatShowingCount", () => {
  it("renders Showing N of M when the total is known", () => {
    expect(formatShowingCount(100, 250)).toBe("Showing 100 of 250");
    expect(formatShowingCount(0, 0)).toBe("Showing 0 of 0");
  });

  it("falls back to Showing N while the total is unknown", () => {
    expect(formatShowingCount(100, null)).toBe("Showing 100");
    expect(formatShowingCount(100, undefined)).toBe("Showing 100");
  });
});

describe("hasUnloadedTasks", () => {
  it("is true when loaded is below the total", () => {
    expect(hasUnloadedTasks(100, 250)).toBe(true);
    expect(hasUnloadedTasks(0, 1)).toBe(true);
  });

  it("is false when everything is loaded or the total is unknown", () => {
    expect(hasUnloadedTasks(100, 100)).toBe(false);
    expect(hasUnloadedTasks(50, 50)).toBe(false);
    expect(hasUnloadedTasks(100, null)).toBe(false);
    expect(hasUnloadedTasks(100, undefined)).toBe(false);
  });
});

describe("boardColumnTruncationNotice", () => {
  it("returns a notice naming loaded vs total when truncated", () => {
    expect(boardColumnTruncationNotice(100, 250)).toBe(
      "Showing first 100 of 250 tasks — more tasks are in other pages."
    );
  });

  it("uses singular wording for exactly one unloaded task", () => {
    expect(boardColumnTruncationNotice(249, 250)).toBe(
      "Showing first 249 of 250 tasks — more task is in other pages."
    );
  });

  it("returns null when everything is loaded or the total is unknown", () => {
    expect(boardColumnTruncationNotice(100, 100)).toBeNull();
    expect(boardColumnTruncationNotice(0, null)).toBeNull();
  });
});

describe("firstPageTruncationMessage", () => {
  it("returns a Showing first N of M message when a single page was truncated", () => {
    expect(firstPageTruncationMessage(100, 142)).toBe("Showing first 100 of 142 tasks.");
  });

  it("returns null when nothing was truncated", () => {
    expect(firstPageTruncationMessage(42, 42)).toBeNull();
    expect(firstPageTruncationMessage(42, null)).toBeNull();
  });
});
