import {
  scaleTime,
  timeDay,
  timeWeek,
  timeMonth,
  timeYear,
  type ScaleTime,
} from "d3";
import type { TimeResolution } from "@/lib/types";

/**
 * Format a date for `<input type="date">` using LOCAL calendar components.
 * (toISOString().split("T")[0] is UTC and shifts the date west of UTC.)
 */
export function toDateInputValue(date: Date | string | number): string {
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "";
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parse a `YYYY-MM-DD` date-input value as LOCAL midnight (never UTC),
 * so the parsed date matches what the user picked. Returns null for empty/
 * malformed values.
 */
export function fromDateInputValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;

  // Reject rollover artefacts like 2025-02-31 -> 2025-03-03.
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return null;
  }

  return parsed;
}

/** Get the D3 time interval for a resolution */
export function getTimeInterval(resolution: TimeResolution) {
  switch (resolution) {
    case "day":
      return timeDay;
    case "week":
      return timeWeek;
    case "month":
      return timeMonth;
    case "quarter":
      return timeMonth.every(3)!;
    case "year":
      return timeYear;
    default:
      return timeWeek;
  }
}

/** Create a D3 time scale for the given date range and pixel width */
export function createTimeScale(
  startDate: Date,
  endDate: Date,
  width: number
): ScaleTime<number, number> {
  return scaleTime().domain([startDate, endDate]).range([0, width]).clamp(true);
}

/** Format a date based on the current time resolution */
export function formatDateForResolution(
  date: Date,
  resolution: TimeResolution
): string {
  switch (resolution) {
    case "day":
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    case "week":
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    case "month":
      return date.toLocaleDateString(undefined, {
        month: "short",
        year: "numeric",
      });
    case "quarter": {
      const q = Math.floor(date.getMonth() / 3) + 1;
      return `Q${q} ${date.getFullYear()}`;
    }
    case "year":
      return date.getFullYear().toString();
    default:
      return date.toLocaleDateString();
  }
}

/** Get the date range for tasks, with buffer */
export function getDateRange(
  tasks: Array<{ dueDate?: Date | string; startDate?: Date | string | null } | null | undefined>,
  bufferDays = 14,
  maxSpanDays?: number
): { start: Date; end: Date } {
  const validTasks = tasks.filter((task): task is { dueDate: Date | string; startDate?: Date | string | null } => {
    if (!task || task.dueDate == null) {
      return false;
    }

    return !Number.isNaN(new Date(task.dueDate).getTime());
  });

  if (validTasks.length === 0) {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    const end = new Date(now);
    end.setDate(end.getDate() + 30);
    return { start, end };
  }

  let min = Infinity;
  let max = -Infinity;

  for (const task of validTasks) {
    const due = new Date(task.dueDate).getTime();
    if (due < min) min = due;
    if (due > max) max = due;

    if (task.startDate) {
      const start = new Date(task.startDate).getTime();
      if (start < min) min = start;
    }
  }

  const start = new Date(min);
  start.setDate(start.getDate() - bufferDays);
  const end = new Date(max);
  end.setDate(end.getDate() + bufferDays);

  if (typeof maxSpanDays === "number") {
    const maxEndTime = start.getTime() + maxSpanDays * 86_400_000;
    if (end.getTime() > maxEndTime) {
      return {
        start,
        end: new Date(maxEndTime),
      };
    }
  }

  return { start, end };
}
