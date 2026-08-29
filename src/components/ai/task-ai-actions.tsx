"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";

import { trpc } from "@/lib/trpc-client";
import { getMutationErrorMessage } from "@/lib/task-format";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Markdown } from "@/components/ui/markdown";
import { AiActionProposals } from "@/components/ai/ai-action-proposals";
import type { AppRouter } from "@/server/routers/_app";

/**
 * CITADEL-d77.32: "Summarize" + "Break down" actions for the task detail
 * panel, placed next to the AI chat launcher. Both features hide themselves
 * when the project has no usable AI provider. Summaries render through the
 * shared Markdown component; breakdown proposals reuse the normal AI approval
 * cards (nothing executes without approval).
 */

type RouterOutputs = inferRouterOutputs<AppRouter>;
type TaskSummaryResponse = RouterOutputs["ai"]["summarizeTask"];

interface TaskAiActionsProps {
  projectId: string;
  taskId: string;
  taskKey: string;
  taskTitle: string;
}

function buildSummaryMarkdown(result: {
  summary: string;
  decisions: string[];
  openQuestions: string[];
  nextSteps: string[];
}) {
  const lines = [result.summary];
  if (result.decisions.length > 0) {
    lines.push("", "### Decisions", ...result.decisions.map((entry) => `- ${entry}`));
  }
  if (result.openQuestions.length > 0) {
    lines.push("", "### Open questions", ...result.openQuestions.map((entry) => `- ${entry}`));
  }
  if (result.nextSteps.length > 0) {
    lines.push("", "### Next steps", ...result.nextSteps.map((entry) => `- ${entry}`));
  }
  return lines.join("\n");
}

export function TaskAiActions({ projectId, taskId, taskKey, taskTitle }: TaskAiActionsProps) {
  const utils = trpc.useUtils();
  const { data: availability } = trpc.ai.hasUsableProvider.useQuery({ projectId });

  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summary, setSummary] = useState<TaskSummaryResponse | null>(null);
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const summarize = trpc.ai.summarizeTask.useMutation({
    onSuccess: (result) => {
      setSummary(result);
      setActionError(null);
      setSummaryOpen(true);
    },
    onError: (error) => setActionError(getMutationErrorMessage(error)),
  });

  const startBreakdown = trpc.ai.startBreakdown.useMutation({
    onSuccess: (result) => {
      setConversationId(result.conversationId);
      setActionError(null);
      setBreakdownOpen(true);
      void utils.ai.listConversations.invalidate({ projectId, taskId });
    },
    onError: (error) => setActionError(getMutationErrorMessage(error)),
  });

  const approveAction = trpc.ai.approveAction.useMutation({
    onSuccess: () => {
      void utils.task.list.invalidate();
      void utils.task.byId.invalidate({ id: taskId });
    },
    onError: (error) => setActionError(getMutationErrorMessage(error)),
  });
  const rejectAction = trpc.ai.rejectAction.useMutation({
    onError: (error) => setActionError(getMutationErrorMessage(error)),
  });
  const rollbackAction = trpc.ai.rollbackAction.useMutation({
    onSuccess: () => {
      void utils.task.list.invalidate();
      void utils.task.byId.invalidate({ id: taskId });
    },
    onError: (error) => setActionError(getMutationErrorMessage(error)),
  });

  const { data: conversation } = trpc.ai.getConversation.useQuery(
    { id: conversationId ?? "" },
    { enabled: Boolean(conversationId) && breakdownOpen }
  );

  // Hide entirely when the project has no usable AI provider.
  if (availability && !availability.hasUsableProvider) {
    return null;
  }

  const proposals = conversation?.actionExecutions ?? [];

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => summarize.mutate({ taskId })}
        disabled={summarize.isPending}
      >
        {summarize.isPending ? "Summarizing..." : "Summarize"}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => startBreakdown.mutate({ taskId })}
        disabled={startBreakdown.isPending}
      >
        {startBreakdown.isPending ? "Breaking down..." : "Break down"}
      </Button>

      <Dialog
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        title={`AI summary · ${taskKey}`}
        description={taskTitle}
        panelClassName="max-w-2xl"
      >
        {actionError && (
          <Alert variant="danger" className="mb-3">
            {actionError}
          </Alert>
        )}
        {summary && (
          <div className="space-y-3">
            <Markdown source={buildSummaryMarkdown(summary)} breaks />
            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {summary.cached
                  ? `Cached summary from ${new Date(summary.generatedAt).toLocaleString()}.`
                  : `Generated ${new Date(summary.generatedAt).toLocaleString()}.`}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => summarize.mutate({ taskId, force: true })}
                disabled={summarize.isPending}
              >
                {summarize.isPending ? "Regenerating..." : "Regenerate"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={breakdownOpen}
        onClose={() => setBreakdownOpen(false)}
        title={`Break down · ${taskKey}`}
        description="Review the proposed subtasks below — approve the ones you want."
        panelClassName="max-w-2xl"
      >
        {actionError && (
          <Alert variant="danger" className="mb-3">
            {actionError}
          </Alert>
        )}
        {conversation?.messages
          .filter((message) => message.role === "assistant")
          .map((message) => (
            <Markdown key={message.id} source={message.content} breaks />
          ))}
        {proposals.length > 0 ? (
          <AiActionProposals
            proposals={proposals}
            isPending={approveAction.isPending || rejectAction.isPending || rollbackAction.isPending}
            onApprove={(proposalId) => approveAction.mutate({ id: proposalId })}
            onReject={(proposalId) => rejectAction.mutate({ id: proposalId })}
            onRollback={(proposalId) => rollbackAction.mutate({ id: proposalId })}
          />
        ) : (
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
            The AI did not propose any subtasks yet. Open the task AI chat to ask follow-ups.
          </p>
        )}
      </Dialog>
    </>
  );
}
