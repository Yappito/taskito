import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createTimeScale,
  getDateRange,
  formatDateForResolution,
  getTimeInterval,
  toDateInputValue,
  fromDateInputValue,
} from "@/lib/date-utils";

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

describe("toDateInputValue / fromDateInputValue (local date handling)", () => {
  const ORIGINAL_TZ = process.env.TZ;

  beforeAll(() => {
    // Fix the process to a timezone west of UTC so the old
    // toISOString().split("T")[0] behaviour would visibly shift dates.
    process.env.TZ = "America/New_York";
  });

  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it("fixed-TZ sanity: 06:00Z keeps the same calendar day under America/New_York", () => {
    // Guards against the env change silently not taking effect.
    expect(new Date("2025-01-15T06:00:00Z").getDate()).toBe(15);
  });

  it("toDateInputValue renders local Y-M-D components", () => {
    // 04:30 UTC on Jan 15 == 23:30 on Jan 14 in winter New York; UTC formatting would say 01-15.
    expect(toDateInputValue("2025-01-15T04:30:00Z")).toBe("2025-01-14");
    expect(toDateInputValue("2025-01-15T06:00:00Z")).toBe("2025-01-15");
    expect(toDateInputValue("2025-07-15T00:30:00Z")).toBe("2025-07-14"); // EDT, 20:30 local
    expect(toDateInputValue("2025-07-15T11:30:00Z")).toBe("2025-07-15");
    expect(toDateInputValue(new Date(2026, 1, 3))).toBe("2026-02-03");
  });

  it("toDateInputValue round-trips through fromDateInputValue", () => {
    const input = "2025-11-05";
    expect(toDateInputValue(fromDateInputValue(input)!)).toBe(input);
    expect(fromDateInputValue(toDateInputValue("2025-05-01T12:00:00Z"))).not.toBeNull();
  });

  it("fromDateInputValue parses as local midnight (not UTC)", () => {
    const parsed = fromDateInputValue("2025-11-05");
    expect(parsed).not.toBeNull();
    expect(parsed!.getFullYear()).toBe(2025);
    expect(parsed!.getMonth()).toBe(10);
    expect(parsed!.getDate()).toBe(5);
    expect(parsed!.getHours()).toBe(0);
    expect(parsed!.getMinutes()).toBe(0);
    // Copy of the input via the constructor is parsed as UTC and differs in a non-UTC timezone.
    const utcParse = new Date("2025-11-05");
    expect(utcParse.getHours()).toBe(19); // 19:00 on Nov 4 in EST
    expect(utcParse.getTime()).not.toBe(parsed!.getTime());
  });

  it("fromDateInputValue rejects empty and malformed values", () => {
    expect(fromDateInputValue("")).toBeNull();
    expect(fromDateInputValue(null)).toBeNull();
    expect(fromDateInputValue(undefined)).toBeNull();
    expect(fromDateInputValue("not a date")).toBeNull();
    expect(fromDateInputValue("2025-13-01")).toBeNull();
    expect(fromDateInputValue("31-12-2025")).toBeNull();
    expect(fromDateInputValue("2025-02-31")).toBeNull(); // rollover, not a real day
    expect(fromDateInputValue("2025-02-30")).toBeNull();
  });

  it("fromDateInputValue accepts leap days", () => {
    expect(fromDateInputValue("2024-02-29")).not.toBeNull();
    expect(fromDateInputValue("2023-02-29")).toBeNull();
  });
});
