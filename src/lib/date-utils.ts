import {
  scaleTime,
  timeDay,
  timeWeek,
  timeMonth,
  timeYear,
  type ScaleTime,
} from "d3";
import type { TimeResolution } from "@/lib/types";

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
  return scaleTime().domain([startDate, endDate]).range([0, width]);
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
  tasks: Array<{ dueDate: Date | string; startDate?: Date | string | null }>,
  bufferDays = 14
): { start: Date; end: Date } {
  if (tasks.length === 0) {
    const now = new Date();
    const start = new Date(now);
    start.setDate(start.getDate() - 30);
    const end = new Date(now);
    end.setDate(end.getDate() + 30);
    return { start, end };
  }

  let min = Infinity;
  let max = -Infinity;

  for (const task of tasks) {
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

  return { start, end };
}
