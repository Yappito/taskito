import { utcDay, utcDayKey } from "@/server/services/sprint-snapshot";

export interface BurndownDay {
  /** UTC day key ("2026-05-19") */
  date: string;
  /** Actual remaining work, carried forward from the daily snapshots */
  remaining: number;
  /** Linear ideal line from the initial remaining count to zero on the last day */
  ideal: number;
}

export interface SprintSnapshotLike {
  date: Date;
  remainingCount: number;
  completedCount: number;
}

export interface ComputeBurndownArgs {
  startDate: Date;
  endDate: Date;
  snapshots: SprintSnapshotLike[];
}

function dayDiff(from: Date, to: Date) {
  return Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / 86_400_000);
}

/**
 * Build the burndown series between a sprint's start and end dates
 * (inclusive). `remaining` comes from the SprintSnapshot rows (latest known
 * value carried forward onto days without a row), and `ideal` is the classic
 * linear line from the initial remaining work down to zero on the end date —
 * so the ideal endpoints are (start date, initial work) and (end date, 0).
 */
export function computeBurndownDays({ startDate, endDate, snapshots }: ComputeBurndownArgs): BurndownDay[] {
  const start = utcDay(startDate);
  const dayCount = Math.max(1, dayDiff(start, endDate) + 1);
  const sorted = [...snapshots]
    .map((snapshot) => ({ ...snapshot, day: utcDay(snapshot.date) }))
    .sort((left, right) => left.day.getTime() - right.day.getTime());

  const snapshotByDay = new Map<number, { remainingCount: number; completedCount: number }>();
  for (const snapshot of sorted) {
    snapshotByDay.set(dayDiff(start, snapshot.day), {
      remainingCount: snapshot.remainingCount,
      completedCount: snapshot.completedCount,
    });
  }

  const initialRecord = sorted[0];
  const initialTotal = initialRecord
    ? initialRecord.remainingCount + initialRecord.completedCount
    : 0;

  const days: BurndownDay[] = [];
  let lastKnownRemaining = initialRecord ? initialRecord.remainingCount : 0;
  for (let index = 0; index < dayCount; index += 1) {
    const record = snapshotByDay.get(index);
    if (record) {
      lastKnownRemaining = record.remainingCount;
    }
    const divisor = Math.max(1, dayCount - 1);
    const ideal = Math.round(initialTotal * (1 - index / divisor));
    days.push({
      date: utcDayKey(new Date(start.getTime() + index * 86_400_000)),
      remaining: lastKnownRemaining,
      ideal,
    });
  }

  return days;
}