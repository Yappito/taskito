"use client";

import { useMemo, useState } from "react";

import { TaskDetail } from "@/components/task/task-detail";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { trpc } from "@/lib/trpc-client";
import { firstPageTruncationMessage } from "@/lib/task-pagination";
import type { TaskCardData, TaskFilterTagOption } from "@/lib/types";

interface CalendarViewProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string; category?: string }>;
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function dateKey(date: Date | string) {
  return new Date(date).toISOString().split("T")[0];
}

export function CalendarView({ projectId, statuses }: CalendarViewProps) {
  const [cursorDate, setCursorDate] = useState(() => new Date());
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const monthStart = useMemo(() => startOfMonth(cursorDate), [cursorDate]);
  const gridStart = useMemo(() => addDays(monthStart, -monthStart.getDay()), [monthStart]);
  const gridEnd = useMemo(() => addDays(gridStart, 42), [gridStart]);
  // TODO(pagination): load tasks beyond the first page with range-based queries
  // (e.g. paged due-date windows per month grid) instead of a single capped page.
  // Follow-up bead: calendar range-based pagination.
  const { data, isLoading } = trpc.task.list.useQuery({ projectId, dueDateFrom: addDays(gridStart, -1), dueDateTo: addDays(gridEnd, 1), includeArchived: true, limit: 100 });
  const tasks = useMemo(() => (data?.items ?? []) as unknown as TaskCardData[], [data]);
  const truncationNotice = firstPageTruncationMessage(tasks.length, data?.totalCount ?? null);
  const tasksByDate = useMemo(() => {
    const groups = new Map<string, TaskCardData[]>();
    for (const task of tasks) {
      const key = dateKey(task.dueDate);
      if (new Date(task.dueDate) < gridStart || new Date(task.dueDate) > gridEnd) continue;
      groups.set(key, [...(groups.get(key) ?? []), task]);
    }
    return groups;
  }, [gridEnd, gridStart, tasks]);
  const days = Array.from({ length: 42 }, (_, index) => addDays(gridStart, index));

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold" style={{ color: "var(--color-text)" }}>
            {cursorDate.toLocaleString(undefined, { month: "long", year: "numeric" })}
          </h2>
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>Calendar view by task due date.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setCursorDate(new Date(cursorDate.getFullYear(), cursorDate.getMonth() - 1, 1))}>Previous</Button>
          <Button size="sm" variant="outline" onClick={() => setCursorDate(new Date())}>Today</Button>
          <Button size="sm" variant="outline" onClick={() => setCursorDate(new Date(cursorDate.getFullYear(), cursorDate.getMonth() + 1, 1))}>Next</Button>
        </div>
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-2xl border" style={{ borderColor: "var(--color-border)" }}>
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
          <div key={day} className="border-b px-3 py-2 text-xs font-semibold" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-muted)" }}>{day}</div>
        ))}
        {days.map((day) => {
          const key = dateKey(day);
          const dayTasks = tasksByDate.get(key) ?? [];
          const outside = day.getMonth() !== cursorDate.getMonth();
          return (
            <div key={key} className="min-h-32 border-r border-b p-2" style={{ borderColor: "var(--color-border)", backgroundColor: outside ? "var(--color-bg-muted)" : "var(--color-surface)" }}>
              <div className="text-xs font-medium" style={{ color: outside ? "var(--color-text-muted)" : "var(--color-text)" }}>{day.getDate()}</div>
              <div className="mt-2 space-y-1">
                {dayTasks.slice(0, 5).map((task) => (
                  <button key={task.id} onClick={() => setSelectedTaskId(task.id)} className="block w-full truncate rounded-lg px-2 py-1 text-left text-xs" style={{ backgroundColor: `${task.status.color}20`, color: "var(--color-text)" }}>
                    <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: task.status.color }} />
                    {task.title}
                  </button>
                ))}
                {dayTasks.length > 5 && <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>+{dayTasks.length - 5} more</div>}
              </div>
            </div>
          );
        })}
      </div>
      {isLoading && <p className="mt-4 text-sm" style={{ color: "var(--color-text-muted)" }}>Loading calendar...</p>}
      {truncationNotice && (
        <Alert variant="info" title="Calendar is partial:" className="mt-4">
          {truncationNotice} This view shows a single page; tasks outside it are not rendered.
        </Alert>
      )}
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} statuses={statuses} onClose={() => setSelectedTaskId(null)} />}
    </div>
  );
}
