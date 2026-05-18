"use client";

import { trpc } from "@/lib/trpc-client";
import type { TaskFilterTagOption } from "@/lib/types";

interface DashboardViewProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string; category?: string }>;
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

function formatHours(seconds: number) {
  return `${Math.round(seconds / 360) / 10}h`;
}

export function DashboardView({ projectId }: DashboardViewProps) {
  const { data, isLoading } = trpc.analytics.projectSummary.useQuery({ projectId });
  const maxStatus = Math.max(1, ...(data?.statusDistribution ?? []).map((item) => item.count));

  return (
    <div className="space-y-6 p-4 lg:p-6">
      <div>
        <h2 className="text-xl font-semibold" style={{ color: "var(--color-text)" }}>Project dashboard</h2>
        <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>Health, throughput, overdue risk, and time tracking analytics.</p>
      </div>
      {isLoading || !data ? (
        <div className="rounded-2xl border p-8 text-center text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>Loading analytics...</div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            {[
              ["Total", data.totalTasks],
              ["Active", data.activeTasks],
              ["Completed", data.completedTasks],
              ["Overdue", data.overdueTasks],
              ["Done", `${data.completionRate}%`],
              ["Logged", formatHours(data.loggedSeconds)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
                <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>{label}</div>
                <div className="mt-2 text-2xl font-semibold" style={{ color: "var(--color-text)" }}>{value}</div>
              </div>
            ))}
          </div>

          <div className="grid gap-4 xl:grid-cols-2">
            <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
              <h3 className="font-semibold" style={{ color: "var(--color-text)" }}>Status distribution</h3>
              <div className="mt-4 space-y-3">
                {data.statusDistribution.map((status) => (
                  <div key={status.id}>
                    <div className="mb-1 flex justify-between text-xs" style={{ color: "var(--color-text-muted)" }}><span>{status.name}</span><span>{status.count}</span></div>
                    <div className="h-3 overflow-hidden rounded-full" style={{ backgroundColor: "var(--color-bg-muted)" }}>
                      <div className="h-full rounded-full" style={{ width: `${Math.max(5, (status.count / maxStatus) * 100)}%`, backgroundColor: status.color }} />
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
              <h3 className="font-semibold" style={{ color: "var(--color-text)" }}>7-day velocity</h3>
              <div className="mt-4 grid h-48 grid-cols-7 items-end gap-2">
                {data.velocity.map((point) => {
                  const height = Math.max(8, Math.min(100, (point.completed + point.created) * 18));
                  return (
                    <div key={point.date} className="flex h-full flex-col justify-end gap-1 text-center text-[10px]" style={{ color: "var(--color-text-muted)" }}>
                      <div className="rounded-t-lg" style={{ height: `${height}%`, background: "linear-gradient(180deg, var(--color-accent), var(--color-info))" }} title={`${point.created} created, ${point.completed} completed`} />
                      <span>{new Date(point.date).toLocaleDateString(undefined, { weekday: "short" })}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>

          <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
            <h3 className="font-semibold" style={{ color: "var(--color-text)" }}>At-risk tasks</h3>
            <div className="mt-3 divide-y" style={{ borderColor: "var(--color-border)" }}>
              {data.atRiskTasks.length === 0 ? (
                <p className="py-4 text-sm" style={{ color: "var(--color-text-muted)" }}>No overdue active tasks.</p>
              ) : data.atRiskTasks.map((task) => (
                <div key={task.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
                  <div style={{ color: "var(--color-text)" }}>{task.title}</div>
                  <div style={{ color: "var(--color-text-muted)" }}>Due {new Date(task.dueDate).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
