"use client";

import { useState, use } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getAlertConfig } from "@/lib/alert-utils";

const CATEGORIES = ["backlog", "todo", "active", "done", "cancelled"] as const;

const FINAL_STAGE_EXPLANATION = "Final stage marks work as closed. When a task enters this status, Taskito records its closure date automatically and clears it again if the task is reopened. Only one status can be final per project.";

/** Workflow settings page: status CRUD + transition matrix */
export default function WorkflowSettingsPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = use(params);
  const { data: project } = trpc.project.bySlug.useQuery({ slug: projectSlug });

  if (!project) {
    return <div className="p-8" style={{ color: "var(--color-text-muted)" }}>Loading...</div>;
  }

  return <WorkflowSettingsContent projectId={project.id} projectSettings={(project as { settings?: Record<string, unknown> | null }).settings ?? null} />;
}

function WorkflowSettingsContent({ projectId, projectSettings }: { projectId: string; projectSettings: Record<string, unknown> | null }) {
  const utils = trpc.useUtils();
  const { data: statuses = [] } = trpc.workflow.statuses.useQuery({ projectId });
  const { data: transitions = [] } = trpc.workflow.transitions.useQuery({ projectId });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [newStatus, setNewStatus] = useState({ name: "", color: "#3b82f6", category: "todo" as (typeof CATEGORIES)[number], isFinal: false, autoArchive: false, autoArchiveDays: 0 });

  const upsertMutation = trpc.workflow.upsertStatus.useMutation({
    onSuccess: () => {
      utils.workflow.statuses.invalidate();
      setEditingId(null);
      setNewStatus({ name: "", color: "#3b82f6", category: "todo", isFinal: false, autoArchive: false, autoArchiveDays: 0 });
    },
  });

  const deleteMutation = trpc.workflow.deleteStatus.useMutation({
    onSuccess: () => utils.workflow.statuses.invalidate(),
  });

  const addTransitionMutation = trpc.workflow.addTransition.useMutation({
    onSuccess: () => utils.workflow.transitions.invalidate(),
  });

  const removeTransitionMutation = trpc.workflow.removeTransition.useMutation({
    onSuccess: () => utils.workflow.transitions.invalidate(),
  });

  const reorderMutation = trpc.workflow.reorderStatuses.useMutation({
    onSuccess: () => utils.workflow.statuses.invalidate(),
  });

  function hasTransition(fromId: string, toId: string) {
    return transitions.some((t) => t.fromStatusId === fromId && t.toStatusId === toId);
  }

  function getTransitionId(fromId: string, toId: string) {
    return transitions.find((t) => t.fromStatusId === fromId && t.toStatusId === toId)?.id;
  }

  function toggleTransition(fromId: string, toId: string) {
    if (fromId === toId) return;
    const existing = getTransitionId(fromId, toId);
    if (existing) {
      removeTransitionMutation.mutate({ id: existing });
    } else {
      addTransitionMutation.mutate({ projectId, fromStatusId: fromId, toStatusId: toId });
    }
  }

  function moveStatus(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= statuses.length) return;
    const ids = statuses.map((s) => s.id);
    [ids[index], ids[newIndex]] = [ids[newIndex], ids[index]];
    reorderMutation.mutate({ projectId, statusIds: ids });
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8 px-4 py-8 lg:px-6">
      <div className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", background: "linear-gradient(135deg, color-mix(in srgb, var(--color-success) 10%, var(--color-surface)) 0%, var(--color-surface) 60%)", boxShadow: "var(--shadow-sm)" }}>
        <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>Delivery system</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>Workflow Settings</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Configure stages, valid movement rules, closure behavior, and visual due-date alerts.
        </p>
      </div>

      {/* Status List */}
      <section className="rounded-3xl border p-5" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--color-text)" }}>Statuses</h2>
        <div className="space-y-2">
          {statuses.map((status, index) => (
            <div
              key={status.id}
              className="flex items-center gap-3 rounded-2xl border p-3"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
            >
              <div
                className="h-4 w-4 rounded-full"
                style={{ backgroundColor: status.color }}
              />
              {editingId === status.id ? (
                <EditStatusForm
                  status={{ ...status, isFinal: (status as { isFinal?: boolean }).isFinal ?? false, autoArchive: (status as { autoArchive?: boolean }).autoArchive ?? false, autoArchiveDays: (status as { autoArchiveDays?: number }).autoArchiveDays ?? 0 }}
                  onSave={(data) =>
                    upsertMutation.mutate({
                      id: status.id,
                      projectId,
                      ...data,
                      order: status.order,
                    })
                  }
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <span className="flex-1 font-medium" style={{ color: "var(--color-text)" }}>{status.name}</span>
                  <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-secondary)" }}>
                    {status.category}
                  </span>
                  {(status as { isFinal?: boolean }).isFinal && (
                    <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-success-muted)", color: "var(--color-success)" }}>
                      final stage
                    </span>
                  )}
                  {(status as { autoArchive?: boolean }).autoArchive && (
                    <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-warning-muted)", color: "var(--color-warning)" }}>
                      auto-archive{(status as { autoArchiveDays?: number }).autoArchiveDays ? ` (${(status as { autoArchiveDays?: number }).autoArchiveDays}d)` : ""}
                    </span>
                  )}
                  <div className="flex gap-1">
                    <button
                      onClick={() => moveStatus(index, -1)}
                      disabled={index === 0}
                      className="rounded p-1 disabled:opacity-30"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => moveStatus(index, 1)}
                      disabled={index === statuses.length - 1}
                      className="rounded p-1 disabled:opacity-30"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => setEditingId(status.id)}
                      className="rounded p-1"
                      style={{ color: "var(--color-accent)" }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete status "${status.name}"?`)) {
                          deleteMutation.mutate({ id: status.id });
                        }
                      }}
                      className="rounded p-1"
                      style={{ color: "var(--color-danger)" }}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* Add new status */}
        <div className="mt-4 flex flex-col gap-3 rounded-2xl border border-dashed p-4 xl:flex-row xl:items-end" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Name</label>
            <Input
              value={newStatus.name}
              onChange={(e) => setNewStatus({ ...newStatus, name: e.target.value })}
              placeholder="New status name"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Color</label>
            <input
              type="color"
              value={newStatus.color}
              onChange={(e) => setNewStatus({ ...newStatus, color: e.target.value })}
              className="h-9 w-12 cursor-pointer rounded-lg border"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Category</label>
            <select
              value={newStatus.category}
              onChange={(e) =>
                setNewStatus({ ...newStatus, category: e.target.value as (typeof CATEGORIES)[number] })
              }
              className="h-9 rounded-lg border px-2 text-sm"
              style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>
            <input
              type="checkbox"
              checked={newStatus.isFinal}
              onChange={(e) => setNewStatus({ ...newStatus, isFinal: e.target.checked })}
              className="rounded"
            />
            Final stage
          </label>
          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>
            <input
              type="checkbox"
              checked={newStatus.autoArchive}
              onChange={(e) => setNewStatus({ ...newStatus, autoArchive: e.target.checked })}
              className="rounded"
            />
            Auto-archive
          </label>
          {newStatus.autoArchive && (
            <div className="space-y-1">
              <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Delay (days)</label>
              <Input
                type="number"
                min={0}
                max={365}
                value={newStatus.autoArchiveDays}
                onChange={(e) => setNewStatus({ ...newStatus, autoArchiveDays: Number(e.target.value) })}
                className="w-20"
              />
            </div>
          )}
          <Button
            onClick={() =>
              upsertMutation.mutate({
                projectId,
                name: newStatus.name,
                color: newStatus.color,
                order: statuses.length,
                category: newStatus.category,
                isFinal: newStatus.isFinal,
                autoArchive: newStatus.autoArchive,
                autoArchiveDays: newStatus.autoArchiveDays,
              })
            }
            disabled={!newStatus.name.trim()}
          >
            Add
          </Button>
        </div>
        {upsertMutation.error && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>{upsertMutation.error.message}</p>
        )}
        <p className="mt-3 text-xs" style={{ color: "var(--color-text-muted)" }}>{FINAL_STAGE_EXPLANATION}</p>
      </section>

      {/* Transition Matrix */}
      <section className="rounded-3xl border p-5" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
        <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--color-text)" }}>Transition Matrix</h2>
        <p className="mb-3 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Click a cell to allow/disallow a transition from row status → column status.
        </p>
        {statuses.length > 0 && (
          <div className="overflow-x-auto">
            <table className="border-collapse text-sm">
              <thead>
                <tr>
                  <th className="border p-2 text-left" style={{ backgroundColor: "var(--color-bg-muted)", borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>From ↓ / To →</th>
                  {statuses.map((s) => (
                    <th key={s.id} className="border p-2" style={{ backgroundColor: "var(--color-bg-muted)", borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                      <div className="flex items-center gap-1 justify-center">
                        <div
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: s.color }}
                        />
                        <span className="text-xs">{s.name}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {statuses.map((from) => (
                  <tr key={from.id}>
                    <td className="border p-2 font-medium" style={{ borderColor: "var(--color-border)", color: "var(--color-text)" }}>
                      <div className="flex items-center gap-1">
                        <div
                          className="h-2.5 w-2.5 rounded-full"
                          style={{ backgroundColor: from.color }}
                        />
                        {from.name}
                      </div>
                    </td>
                    {statuses.map((to) => (
                      <td
                        key={to.id}
                        className={cn(
                          "border p-2 text-center",
                          from.id === to.id
                            ? ""
                            : "cursor-pointer hover:bg-blue-50"
                        )}
                        style={{
                          borderColor: "var(--color-border)",
                          backgroundColor: from.id === to.id ? "var(--color-bg-muted)" : "var(--color-surface)",
                        }}
                        onClick={() => toggleTransition(from.id, to.id)}
                      >
                        {from.id === to.id ? (
                          <span style={{ color: "var(--color-text-muted)" }}>—</span>
                        ) : hasTransition(from.id, to.id) ? (
                          <span className="font-bold" style={{ color: "var(--color-success)" }}>✓</span>
                        ) : (
                          <span style={{ color: "var(--color-text-muted)" }}>✗</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Due Date Alert Settings */}
      <AlertSettingsSection projectId={projectId} projectSettings={projectSettings} />
    </div>
  );
}

function AlertSettingsSection({ projectId, projectSettings }: { projectId: string; projectSettings: Record<string, unknown> | null }) {
  const utils = trpc.useUtils();
  const config = getAlertConfig(projectSettings);
  const [enabled, setEnabled] = useState(config.enabled);
  const [warningDays, setWarningDays] = useState(config.warningDays);
  const [criticalDays, setCriticalDays] = useState(config.criticalDays);

  const updateProject = trpc.project.update.useMutation({
    onSuccess: () => {
      utils.project.bySlug.invalidate();
    },
  });

  function handleSave() {
    // Merge with existing settings
    const currentSettings = (projectSettings ?? {}) as Record<string, unknown>;
    updateProject.mutate({
      id: projectId,
      settings: {
        ...currentSettings,
        dueDateAlertsEnabled: enabled,
        dueDateWarningDays: warningDays,
        dueDateCriticalDays: criticalDays,
      },
    });
  }

  return (
    <section className="rounded-3xl border p-5" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
      <h2 className="mb-4 text-lg font-semibold" style={{ color: "var(--color-text)" }}>Due Date Alerts</h2>
      <p className="mb-3 text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Tasks approaching their due date will pulsate to draw attention.
      </p>
      <div className="space-y-4 rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded"
          />
          <span className="text-sm font-medium" style={{ color: "var(--color-text)" }}>Enable due date alerts</span>
        </label>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Warning threshold (days)</label>
            <Input
              type="number"
              min={1}
              max={90}
              value={warningDays}
              onChange={(e) => setWarningDays(Number(e.target.value))}
            />
            <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>Tasks pulsate orange when within this many days</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Critical threshold (days)</label>
            <Input
              type="number"
              min={1}
              max={30}
              value={criticalDays}
              onChange={(e) => setCriticalDays(Number(e.target.value))}
            />
            <p className="text-[10px]" style={{ color: "var(--color-text-muted)" }}>Tasks pulsate red when within this many days</p>
          </div>
        </div>
        <Button onClick={handleSave} disabled={updateProject.isPending} size="sm">
          {updateProject.isPending ? "Saving..." : "Save Alert Settings"}
        </Button>
      </div>
    </section>
  );
}

function EditStatusForm({
  status,
  onSave,
  onCancel,
}: {
  status: { name: string; color: string; category: string; isFinal: boolean; autoArchive: boolean; autoArchiveDays: number };
  onSave: (data: { name: string; color: string; category: (typeof CATEGORIES)[number]; isFinal: boolean; autoArchive: boolean; autoArchiveDays: number }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(status.name);
  const [color, setColor] = useState(status.color);
  const [category, setCategory] = useState(status.category as (typeof CATEGORIES)[number]);
  const [isFinal, setIsFinal] = useState(status.isFinal);
  const [autoArchive, setAutoArchive] = useState(status.autoArchive);
  const [autoArchiveDays, setAutoArchiveDays] = useState(status.autoArchiveDays);

  return (
    <div className="flex flex-1 items-center gap-2">
      <Input value={name} onChange={(e) => setName(e.target.value)} className="w-40" />
      <input
        type="color"
        value={color}
        onChange={(e) => setColor(e.target.value)}
        className="h-9 w-10 cursor-pointer rounded-lg border"
        style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
      />
      <select
        value={category}
        onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}
        className="h-9 rounded-lg border px-2 text-sm"
        style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}
      >
        {CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-secondary)" }}>
        <input
          type="checkbox"
          checked={isFinal}
          onChange={(e) => setIsFinal(e.target.checked)}
          className="rounded"
        />
        Final stage
      </label>
      <label className="flex items-center gap-1.5 text-xs" style={{ color: "var(--color-text-secondary)" }}>
        <input
          type="checkbox"
          checked={autoArchive}
          onChange={(e) => setAutoArchive(e.target.checked)}
          className="rounded"
        />
        Auto-archive
      </label>
      {autoArchive && (
        <Input
          type="number"
          min={0}
          max={365}
          value={autoArchiveDays}
          onChange={(e) => setAutoArchiveDays(Number(e.target.value))}
          className="w-20"
          placeholder="Days"
        />
      )}
      <Button size="sm" onClick={() => onSave({ name, color, category, isFinal, autoArchive, autoArchiveDays })}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}
