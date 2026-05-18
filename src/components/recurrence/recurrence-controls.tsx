"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc-client";

type Frequency = "daily" | "weekly" | "monthly" | "yearly";

function dateInputValue(date: string | Date) {
  return new Date(date).toISOString().split("T")[0];
}

function todayDateInputValue() {
  return new Date().toISOString().split("T")[0];
}

export function RecurrenceControls({ taskId, dueDate, rule }: { taskId: string; dueDate: string | Date; rule?: { frequency: Frequency; interval: number; nextDueDate: string | Date; endDate?: string | Date | null } | null }) {
  const utils = trpc.useUtils();
  const [frequency, setFrequency] = useState<Frequency>(rule?.frequency ?? "weekly");
  const [interval, setInterval] = useState(String(rule?.interval ?? 1));
  const today = todayDateInputValue();
  const [formError, setFormError] = useState<string | null>(null);
  const [nextDueDate, setNextDueDate] = useState(() => {
    const initialValue = dateInputValue(rule?.nextDueDate ?? dueDate);
    return rule ? initialValue : (initialValue < today ? today : initialValue);
  });
  const setRecurrence = trpc.recurrence.set.useMutation({
    onSuccess: () => {
      setFormError(null);
      utils.task.byId.invalidate({ id: taskId });
    },
    onError: (error) => {
      setFormError(error.message || "Unable to update recurrence.");
    },
  });
  const removeRecurrence = trpc.recurrence.remove.useMutation({
    onSuccess: () => {
      setFormError(null);
      utils.task.byId.invalidate({ id: taskId });
    },
    onError: (error) => {
      setFormError(error.message || "Unable to remove recurrence.");
    },
  });

  return (
    <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>Recurring task</h3>
          <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
            {rule ? `Repeats ${rule.frequency} every ${rule.interval}` : "Create future task occurrences automatically from this task."}
          </p>
        </div>
        {rule && <Button size="sm" variant="outline" disabled={removeRecurrence.isPending} onClick={() => removeRecurrence.mutate({ taskId })}>Stop repeating</Button>}
      </div>
      <form
        className="mt-3 grid gap-2 sm:grid-cols-[1fr_80px_1fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          if (nextDueDate < today) {
            setFormError("Next due date must be today or later.");
            return;
          }

          setFormError(null);
          setRecurrence.mutate({
            taskId,
            frequency,
            interval: Math.max(1, Number(interval) || 1),
            nextDueDate: new Date(nextDueDate),
          });
        }}
      >
        <select value={frequency} onChange={(event) => setFrequency(event.target.value as Frequency)} className="h-9 rounded-lg border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
          <option value="yearly">Yearly</option>
        </select>
        <input type="number" min={1} value={interval} onChange={(event) => setInterval(event.target.value)} className="h-9 rounded-lg border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }} />
        <input type="date" min={today} value={nextDueDate} onChange={(event) => {
          setNextDueDate(event.target.value);
          if (formError) {
            setFormError(null);
          }
        }} className="h-9 rounded-lg border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }} />
        <Button size="sm" disabled={setRecurrence.isPending}>{rule ? "Update" : "Repeat"}</Button>
      </form>
      {formError ? (
        <p className="mt-2 text-xs" style={{ color: "var(--color-danger, #dc2626)" }}>
          {formError}
        </p>
      ) : null}
    </section>
  );
}
