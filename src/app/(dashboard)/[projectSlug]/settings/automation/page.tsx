"use client";

import { use, useState, type FormEvent } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc-client";

const triggers = ["taskCreated", "statusChanged", "taskAssigned", "commentAdded", "dueDatePassed"] as const;
const actions = ["moveStatus", "assignTask", "addTag", "removeTag", "addComment", "archiveTask", "unarchiveTask"] as const;

export default function AutomationSettingsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = use(params);
  const utils = trpc.useUtils();
  const { data: project, isLoading } = trpc.project.bySlug.useQuery({ slug: projectSlug });
  const { data: rules = [] } = trpc.automation.list.useQuery({ projectId: project?.id ?? "" }, { enabled: !!project?.id });
  const { data: runs = [] } = trpc.automation.runs.useQuery({ projectId: project?.id ?? "" }, { enabled: !!project?.id });
  const [error, setError] = useState<string | null>(null);
  const createRule = trpc.automation.create.useMutation({
    onSuccess: () => {
      setError(null);
      utils.automation.list.invalidate({ projectId: project?.id ?? "" });
    },
    onError: (err) => setError(err.message),
  });
  const updateRule = trpc.automation.update.useMutation({ onSuccess: () => utils.automation.list.invalidate({ projectId: project?.id ?? "" }) });
  const deleteRule = trpc.automation.delete.useMutation({ onSuccess: () => utils.automation.list.invalidate({ projectId: project?.id ?? "" }) });
  const processDueDates = trpc.automation.processDueDates.useMutation({ onSuccess: () => utils.automation.runs.invalidate({ projectId: project?.id ?? "" }) });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!project) return;
    const form = new FormData(event.currentTarget);
    try {
      createRule.mutate({
        projectId: project.id,
        name: String(form.get("name") || "Automation"),
        trigger: form.get("trigger") as (typeof triggers)[number],
        triggerCondition: JSON.parse(String(form.get("triggerCondition") || "{}")) as Record<string, unknown>,
        action: form.get("action") as (typeof actions)[number],
        actionPayload: JSON.parse(String(form.get("actionPayload") || "{}")) as Record<string, unknown>,
        isEnabled: true,
      });
      event.currentTarget.reset();
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Invalid JSON");
    }
  }

  if (isLoading) return <div className="p-6">Loading...</div>;
  if (!project) return <div className="p-6">Project not found</div>;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "var(--color-text)" }}>Workflow automation</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>Create owner-managed rules: when a task event happens, run a safe task action.</p>
        </div>
        <Link href={`/${projectSlug}`} className="text-sm underline" style={{ color: "var(--color-accent)" }}>Back to project</Link>
        <Button size="sm" variant="outline" disabled={processDueDates.isPending} onClick={() => processDueDates.mutate({ projectId: project.id })}>Process due-date rules</Button>
      </div>
      {error && <div className="rounded-xl border p-3 text-sm" style={{ borderColor: "var(--color-danger)", color: "var(--color-danger)" }}>{error}</div>}
      <form onSubmit={handleCreate} className="grid gap-3 rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <input name="name" required placeholder="Rule name" className="h-10 rounded-xl border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)", color: "var(--color-text)" }} />
        <div className="grid gap-3 md:grid-cols-2">
          <select name="trigger" className="h-10 rounded-xl border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)", color: "var(--color-text)" }}>{triggers.map((trigger) => <option key={trigger} value={trigger}>{trigger}</option>)}</select>
          <select name="action" className="h-10 rounded-xl border px-3 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)", color: "var(--color-text)" }}>{actions.map((action) => <option key={action} value={action}>{action}</option>)}</select>
        </div>
        <textarea name="triggerCondition" rows={3} defaultValue="{}" className="rounded-xl border p-3 font-mono text-xs" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)", color: "var(--color-text)" }} />
        <textarea name="actionPayload" rows={4} defaultValue={'{"content":"Automation ran"}'} className="rounded-xl border p-3 font-mono text-xs" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg)", color: "var(--color-text)" }} />
        <Button type="submit" disabled={createRule.isPending}>Create rule</Button>
      </form>
      <section className="space-y-3">
        {rules.map((rule) => (
          <div key={rule.id} className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-semibold" style={{ color: "var(--color-text)" }}>{rule.name}</h2>
                <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>{rule.trigger} → {rule.action}</p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => updateRule.mutate({ id: rule.id, isEnabled: !rule.isEnabled })}>{rule.isEnabled ? "Disable" : "Enable"}</Button>
                <Button size="sm" variant="destructive" onClick={() => deleteRule.mutate({ id: rule.id })}>Delete</Button>
              </div>
            </div>
          </div>
        ))}
      </section>
      <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h2 className="font-semibold" style={{ color: "var(--color-text)" }}>Recent runs</h2>
        <div className="mt-3 space-y-2">
          {runs.slice(0, 20).map((run) => (
            <div key={run.id} className="flex flex-wrap justify-between gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
              <span>{run.rule.name} · {run.trigger}</span>
              <span>{run.status}{run.message ? ` — ${run.message}` : ""}</span>
            </div>
          ))}
          {runs.length === 0 && <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No automation runs yet.</p>}
        </div>
      </section>
    </div>
  );
}
