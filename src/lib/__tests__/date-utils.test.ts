import { describe, it, expect } from "vitest";
import { createTimeScale, getDateRange, formatDateForResolution, getTimeInterval } from "@/lib/date-utils";

describe("date-utils", () => {
  it("createTimeScale maps dates to pixel range", () => {
    const start = new Date("2025-01-01");
    const end = new Date("2025-12-31");
    const scale = createTimeScale(start, end, 1000);

    expect(scale(start)).toBe(0);
    expect(scale(end)).toBe(1000);
    expect(scale(new Date("2025-07-01"))).toBeGreaterThan(400);
    expect(scale(new Date("2025-07-01"))).toBeLessThan(600);
  });

  it("getDateRange computes range from tasks", () => {
    const tasks = [
      { dueDate: new Date("2025-03-01") },
      { dueDate: new Date("2025-06-15") },
      { dueDate: new Date("2025-01-10") },
    ];
    const range = getDateRange(tasks);
    expect(range.start.getTime()).toBeLessThanOrEqual(new Date("2025-01-10").getTime());
    expect(range.end.getTime()).toBeGreaterThanOrEqual(new Date("2025-06-15").getTime());
  });

  it("formatDateForResolution returns strings", () => {
    const date = new Date("2025-03-15");
    expect(formatDateForResolution(date, "day")).toBeTruthy();
    expect(formatDateForResolution(date, "week")).toBeTruthy();
    expect(formatDateForResolution(date, "month")).toBeTruthy();
    expect(formatDateForResolution(date, "quarter")).toBeTruthy();
    expect(formatDateForResolution(date, "year")).toBeTruthy();
  });

  it("getTimeInterval returns d3 intervals", () => {
    expect(getTimeInterval("day")).toBeTruthy();
    expect(getTimeInterval("week")).toBeTruthy();
    expect(getTimeInterval("month")).toBeTruthy();
  });
});
