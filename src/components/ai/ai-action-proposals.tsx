"use client";

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
  onApprove: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
  onRollback: (proposalId: string) => void;
  className?: string;
}

function formatProposalTimestamp(value: string | Date) {
  return new Date(value).toLocaleString();
}

export function AiActionProposals({ proposals, isPending = false, onApprove, onReject, onRollback, className }: AiActionProposalsProps) {
  if (proposals.length === 0) {
    return null;
  }

  return (
    <div className={className ?? "space-y-3"}>
      {proposals.map((proposal) => {
        const isExecuted = proposal.status === "executed";

        const actions = (
          <div className="flex gap-2">
            {proposal.status === "proposed" && (
              <>
                <Button size="sm" disabled={isPending} onClick={() => onApprove(proposal.id)}>Approve</Button>
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
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-xl border p-3 text-xs" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
              {JSON.stringify(proposal.proposedPayload, null, 2)}
            </pre>
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
