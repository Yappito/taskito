"use client";

import { useMemo, useState } from "react";

import { TaskDetail } from "@/components/task/task-detail";
import { Alert, Button, EmptyState, Skeleton } from "@/components/ui";
import { trpc } from "@/lib/trpc-client";
import type { TaskCardData, TaskFilterTagOption } from "@/lib/types";

interface GanttViewProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string; category?: string }>;
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

function dayStart(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function daysBetween(start: Date, end: Date) {
  return Math.max(1, Math.ceil((dayStart(end).getTime() - dayStart(start).getTime()) / 86_400_000) + 1);
}

export function GanttView({ projectId, statuses }: GanttViewProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const { data, isLoading, error } = trpc.task.list.useQuery({ projectId, includeArchived: false, limit: 100 });
  const tasks = useMemo(() => (data?.items ?? []) as unknown as TaskCardData[], [data?.items]);
  const range = useMemo(() => {
    const dates = tasks.flatMap((task) => [task.startDate ? new Date(task.startDate) : new Date(task.dueDate), new Date(task.dueDate)]);
    const minTime = dates.reduce((minimum, date) => Math.min(minimum, date.getTime()), Number.POSITIVE_INFINITY);
    const maxTime = dates.reduce((maximum, date) => Math.max(maximum, date.getTime()), Number.NEGATIVE_INFINITY);
    const min = dates.length ? new Date(minTime) : new Date();
    const max = dates.length ? new Date(maxTime) : new Date();
    min.setDate(min.getDate() - 2);
    max.setDate(max.getDate() + 2);
    return { min: dayStart(min), max: dayStart(max), days: daysBetween(min, max) };
  }, [tasks]);
  const totalWidth = Math.max(900, range.days * 44);
  const ticks = Array.from({ length: range.days }, (_, index) => {
    const date = new Date(range.min);
    date.setDate(date.getDate() + index);
    return date;
  });

  return (
    <div className="p-4 lg:p-6">
      <div className="mb-4">
        <h2 className="text-xl font-semibold" style={{ color: "var(--color-text)" }}>Gantt timeline</h2>
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>Task bars span start date to due date. Click a bar to open details.</p>
      </div>
      <div className="overflow-x-auto rounded-2xl border" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <div style={{ width: totalWidth }}>
          <div className="sticky top-0 z-10 grid border-b" style={{ gridTemplateColumns: `220px repeat(${range.days}, 44px)`, borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-muted)" }}>
            <div className="border-r px-3 py-2 text-xs font-semibold" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>Task</div>
            {ticks.map((tick) => (
              <div key={tick.toISOString()} className="border-r px-1 py-2 text-center text-[10px]" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
                {tick.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </div>
            ))}
          </div>
          <div className="divide-y" style={{ borderColor: "var(--color-border)" }}>
            {tasks.map((task) => {
              const start = dayStart(task.startDate ? new Date(task.startDate) : new Date(task.dueDate));
              const due = dayStart(new Date(task.dueDate));
              const offset = Math.max(0, daysBetween(range.min, start) - 1);
              const span = Math.max(1, daysBetween(start, due));
              const barWidth = Math.max(36, span * 44 - 8);
              const showBarTitle = barWidth >= 120;
              return (
                <div key={task.id} className="grid items-center" style={{ gridTemplateColumns: `220px repeat(${range.days}, 44px)`, minHeight: 56 }}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedTaskId(task.id)}
                    aria-label={`Open ${task.title}`}
                    className="h-auto w-full justify-start rounded-none border-r px-3 py-2 text-left text-sm font-normal"
                    style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}
                  >
                    <span className="block min-w-0 truncate">{task.title}</span>
                  </Button>
                  <div className="relative col-span-full col-start-2 row-start-1 h-9">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setSelectedTaskId(task.id)}
                      className="absolute top-1/2 flex h-7 -translate-y-1/2 items-center overflow-hidden rounded-full px-2 text-left text-xs font-medium whitespace-nowrap shadow-sm transition-transform hover:scale-[1.01] motion-reduce:transition-none motion-reduce:hover:scale-100"
                      title={task.title}
                      aria-label={`Open ${task.title}`}
                      style={{
                        left: offset * 44 + 4,
                        width: barWidth,
                        backgroundColor: task.status.color,
                        color: "var(--color-on-accent)",
                      }}
                    >
                      {showBarTitle ? <span className="block min-w-0 truncate">{task.title}</span> : <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full opacity-80" style={{ backgroundColor: "var(--color-on-accent)" }} />}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {error ? (
            <div className="p-4">
              <Alert variant="danger" title="Couldn't load tasks.">
                {error.message || "Please try again later."}
              </Alert>
            </div>
          ) : isLoading ? (
            <div className="flex flex-col gap-3 p-4" aria-label="Loading gantt chart">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : tasks.length === 0 ? (
            <EmptyState
              title="No tasks to show."
              description="Tasks with start or due dates appear here as bars on the timeline."
              className="p-8"
            />
          ) : null}
        </div>
      </div>
      {selectedTaskId && <TaskDetail taskId={selectedTaskId} statuses={statuses} onClose={() => setSelectedTaskId(null)} />}
    </div>
  );
}
