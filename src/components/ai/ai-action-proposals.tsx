"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";

interface AiActionProposalItem {
  id: string;
  actionType: string;
  title?: string | null;
  summary?: string | null;
  status: string;
  rollbackStatus?: string;
  rollbackErrorMessage?: string | null;
  rolledBackAt?: string | Date | null;
  createdAt: string | Date;
  errorMessage?: string | null;
  proposedPayload: Record<string, unknown>;
}

interface AiActionProposalsProps {
  proposals: AiActionProposalItem[];
  isPending?: boolean;
  onApprove: (proposalId: string, overridePayload?: Record<string, unknown>) => void;
  onReject: (proposalId: string) => void;
  onRollback: (proposalId: string) => void;
  className?: string;
}

function formatProposalTimestamp(value: string | Date) {
  return new Date(value).toLocaleString();
}

function stringifyValue(value: unknown) {
  if (value == null) return "None";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function describePayload(actionType: string, payload: Record<string, unknown>) {
  const rows: Array<{ label: string; value: unknown; tone?: "accent" | "muted" }> = [];
  if (typeof payload.taskId === "string") rows.push({ label: "Task", value: payload.taskId, tone: "accent" });
  if (typeof payload.title === "string") rows.push({ label: actionType === "createTask" ? "New title" : "Title", value: payload.title });
  if (typeof payload.content === "string") rows.push({ label: "Comment", value: payload.content });
  if (typeof payload.statusId === "string") rows.push({ label: "Target status", value: payload.statusId, tone: "accent" });
  if ("assigneeId" in payload) rows.push({ label: "Assignee", value: payload.assigneeId, tone: "accent" });
  if (typeof payload.priority === "string") rows.push({ label: "Priority", value: payload.priority });
  if (typeof payload.dueDate === "string") rows.push({ label: "Due date", value: new Date(payload.dueDate).toLocaleDateString() });
  if (typeof payload.startDate === "string") rows.push({ label: "Start date", value: new Date(payload.startDate).toLocaleDateString() });
  if (Array.isArray(payload.taskIds)) rows.push({ label: "Tasks", value: `${payload.taskIds.length} selected tasks`, tone: "accent" });
  if (Array.isArray(payload.tagIds)) rows.push({ label: "Tags", value: payload.tagIds });
  if (Array.isArray(payload.addTagIds)) rows.push({ label: "Add tags", value: payload.addTagIds });
  if (Array.isArray(payload.removeTagIds)) rows.push({ label: "Remove tags", value: payload.removeTagIds });
  if (typeof payload.sourceTaskId === "string") rows.push({ label: "Source", value: payload.sourceTaskId });
  if (typeof payload.targetTaskId === "string") rows.push({ label: "Target", value: payload.targetTaskId });
  if (typeof payload.linkType === "string") rows.push({ label: "Link", value: payload.linkType });
  if (typeof payload.archive === "boolean") rows.push({ label: "Archive", value: payload.archive ? "Yes" : "No" });
  return rows;
}

function PayloadPreview({ actionType, payload }: { actionType: string; payload: Record<string, unknown> }) {
  const rows = describePayload(actionType, payload);
  if (rows.length === 0) {
    return <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No editable fields were provided.</p>;
  }
  return (
    <div className="grid gap-2 md:grid-cols-2">
      {rows.map((row) => (
        <div key={`${row.label}-${stringifyValue(row.value)}`} className="rounded-xl border px-3 py-2" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>{row.label}</div>
          <div className="mt-1 break-words text-sm" style={{ color: row.tone === "accent" ? "var(--color-accent)" : "var(--color-text)" }}>{stringifyValue(row.value)}</div>
        </div>
      ))}
    </div>
  );
}

function PayloadEditor({ value, onChange }: { value: Record<string, unknown>; onChange: (next: Record<string, unknown>) => void }) {
  const [draft, setDraft] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <textarea
        value={draft}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          try {
            const parsed = JSON.parse(nextDraft) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("Payload must be a JSON object");
            }
            setError(null);
            onChange(parsed as Record<string, unknown>);
          } catch (parseError) {
            setError(parseError instanceof Error ? parseError.message : "Invalid JSON");
          }
        }}
        className="min-h-40 w-full rounded-xl border p-3 font-mono text-xs"
        style={{ borderColor: error ? "var(--color-danger)" : "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
      />
      <p className="text-xs" style={{ color: error ? "var(--color-danger)" : "var(--color-text-muted)" }}>
        {error ?? "Edit the proposal payload before approval. Server-side validation still runs before execution."}
      </p>
    </div>
  );
}

export function AiActionProposals({ proposals, isPending = false, onApprove, onReject, onRollback, className }: AiActionProposalsProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [payloadOverrides, setPayloadOverrides] = useState<Record<string, Record<string, unknown>>>({});
  const proposedCount = useMemo(() => proposals.filter((proposal) => proposal.status === "proposed").length, [proposals]);

  if (proposals.length === 0) {
    return null;
  }

  return (
    <div className={className ?? "space-y-3"}>
      {proposedCount > 1 && (
        <div className="flex flex-wrap gap-2 rounded-2xl border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
          <span className="self-center text-sm font-medium" style={{ color: "var(--color-text)" }}>{proposedCount} pending AI actions</span>
          <Button size="sm" disabled={isPending} onClick={() => proposals.filter((proposal) => proposal.status === "proposed").forEach((proposal) => onApprove(proposal.id, payloadOverrides[proposal.id]))}>Approve all</Button>
          <Button size="sm" variant="outline" disabled={isPending} onClick={() => proposals.filter((proposal) => proposal.status === "proposed").forEach((proposal) => onReject(proposal.id))}>Reject all</Button>
        </div>
      )}
      {proposals.map((proposal) => {
        const isExecuted = proposal.status === "executed";
        const isEditing = editingId === proposal.id;
        const currentPayload = payloadOverrides[proposal.id] ?? proposal.proposedPayload;

        const actions = (
          <div className="flex flex-wrap gap-2">
            {proposal.status === "proposed" && (
              <>
                <Button size="sm" disabled={isPending} onClick={() => onApprove(proposal.id, payloadOverrides[proposal.id])}>{isEditing ? "Approve edited" : "Approve"}</Button>
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => setEditingId(isEditing ? null : proposal.id)}>{isEditing ? "Preview" : "Edit"}</Button>
                <Button size="sm" variant="outline" disabled={isPending} onClick={() => onReject(proposal.id)}>Reject</Button>
              </>
            )}
            {proposal.status === "executed" && proposal.rollbackStatus === "available" && (
              <Button size="sm" variant="outline" disabled={isPending} onClick={() => onRollback(proposal.id)}>Rollback</Button>
            )}
          </div>
        );

        const badges = (
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium" style={{ color: "var(--color-text)" }}>
              {proposal.title || proposal.actionType}
            </span>
            <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-secondary)" }}>
              {proposal.status}
            </span>
            {proposal.rollbackStatus && proposal.rollbackStatus !== "unavailable" && (
              <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-secondary)" }}>
                rollback: {proposal.rollbackStatus}
              </span>
            )}
          </div>
        );

        const detailsBody = (
          <>
            {isEditing ? (
              <PayloadEditor
                value={currentPayload}
                onChange={(nextPayload) => setPayloadOverrides((current) => ({ ...current, [proposal.id]: nextPayload }))}
              />
            ) : (
              <PayloadPreview actionType={proposal.actionType} payload={currentPayload} />
            )}
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer" style={{ color: "var(--color-text-muted)" }}>Raw payload</summary>
              <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-xl border p-3" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                {JSON.stringify(currentPayload, null, 2)}
              </pre>
            </details>
            {proposal.errorMessage && (
              <p className="mt-2 text-sm" style={{ color: "var(--color-danger)" }}>{proposal.errorMessage}</p>
            )}
            {proposal.rollbackErrorMessage && (
              <p className="mt-2 text-sm" style={{ color: "var(--color-danger)" }}>{proposal.rollbackErrorMessage}</p>
            )}
          </>
        );

        if (isExecuted) {
          return (
            <div
              key={proposal.id}
              className="rounded-2xl border p-3"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
            >
              <div className="mb-2 flex items-center justify-between gap-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
                <span className="font-semibold">Taskito AI action</span>
                <span className="shrink-0">{formatProposalTimestamp(proposal.createdAt)}</span>
              </div>
              <div className="flex items-start gap-3">
                <details className="min-w-0 flex-1">
                  <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
                    <div className="min-w-0">
                      {badges}
                      {proposal.summary && (
                        <p className="mt-1 truncate text-sm" style={{ color: "var(--color-text-secondary)" }}>{proposal.summary}</p>
                      )}
                    </div>
                    <span className="shrink-0 text-xs" style={{ color: "var(--color-text-muted)" }}>Details</span>
                  </summary>
                  <div className="mt-3">
                    {detailsBody}
                  </div>
                </details>
                {proposal.rollbackStatus === "available" && actions}
              </div>
            </div>
          );
        }

        return (
          <div
            key={proposal.id}
            className="rounded-2xl border p-4"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
          >
            <div className="mb-2 flex items-center justify-between gap-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
              <span className="font-semibold">Taskito AI action</span>
              <span className="shrink-0">{formatProposalTimestamp(proposal.createdAt)}</span>
            </div>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div className="min-w-0">
                {badges}
                {proposal.summary && (
                  <p className="mt-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>{proposal.summary}</p>
                )}
                <div className="mt-3">
                  {detailsBody}
                </div>
              </div>
              {actions}
            </div>
          </div>
        );
      })}
    </div>
  );
}
