"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc-client";

function formatSeconds(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function TimeTrackingControls({
  projectId,
  taskId,
  dragHandle,
}: {
  projectId: string;
  taskId: string;
  dragHandle?: ReactNode;
}) {
  const utils = trpc.useUtils();
  const { data: summary } = trpc.timeLog.summary.useQuery({ projectId, taskId });
  const { data: logs = [] } = trpc.timeLog.listForTask.useQuery({ taskId });
  const [manualMinutes, setManualMinutes] = useState("30");
  const [manualDescription, setManualDescription] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const running = summary?.running ?? null;

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  const runningSeconds = useMemo(() => {
    if (!running) return 0;
    return Math.max(0, Math.round((now - new Date(running.startedAt).getTime()) / 1000));
  }, [now, running]);

  const startTimer = trpc.timeLog.startTimer.useMutation({
    onSuccess: () => {
      utils.timeLog.summary.invalidate({ projectId, taskId });
      utils.timeLog.listForTask.invalidate({ taskId });
    },
  });
  const stopTimer = trpc.timeLog.stopTimer.useMutation({
    onSuccess: () => {
      utils.timeLog.summary.invalidate({ projectId, taskId });
      utils.timeLog.listForTask.invalidate({ taskId });
      utils.analytics.projectSummary.invalidate({ projectId });
    },
  });
  const addManual = trpc.timeLog.addManual.useMutation({
    onSuccess: () => {
      setManualDescription("");
      utils.timeLog.summary.invalidate({ projectId, taskId });
      utils.timeLog.listForTask.invalidate({ taskId });
      utils.analytics.projectSummary.invalidate({ projectId });
    },
  });

  return (
    <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {dragHandle ? <div className="shrink-0">{dragHandle}</div> : null}
          <div>
            <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>Time tracking</h3>
            <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              Total {formatSeconds(summary?.totalSeconds ?? 0)} · Mine {formatSeconds(summary?.mySeconds ?? 0)}
            </p>
          </div>
        </div>
        {running ? (
          <Button size="sm" variant="outline" disabled={stopTimer.isPending} onClick={() => stopTimer.mutate({ id: running.id })}>
            Stop {formatSeconds(runningSeconds)}
          </Button>
        ) : (
          <Button size="sm" disabled={startTimer.isPending} onClick={() => startTimer.mutate({ taskId })}>
            Start timer
          </Button>
        )}
      </div>

      <form
        className="mt-3 flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          const minutes = Math.max(1, Number(manualMinutes) || 0);
          addManual.mutate({
            taskId,
            startedAt: new Date(Date.now() - minutes * 60_000),
            duration: minutes * 60,
            description: manualDescription || undefined,
          });
        }}
      >
        <input
          type="number"
          min={1}
          max={1440}
          value={manualMinutes}
          onChange={(event) => setManualMinutes(event.target.value)}
          className="h-9 rounded-lg border px-3 text-sm sm:w-28"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
        />
        <input
          value={manualDescription}
          onChange={(event) => setManualDescription(event.target.value)}
          placeholder="Manual log note"
          className="h-9 flex-1 rounded-lg border px-3 text-sm"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={addManual.isPending}>Add minutes</Button>
      </form>

      {logs.length > 0 && (
        <div className="mt-3 space-y-2">
          {logs.slice(0, 5).map((log) => (
            <div key={log.id} className="flex items-center justify-between rounded-xl border px-3 py-2 text-xs" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
              <span>{log.user.name || log.user.email} · {log.description || "Time log"}</span>
              <span>{log.endedAt ? formatSeconds(log.duration) : "Running"}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
