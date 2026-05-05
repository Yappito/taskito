"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc-client";
import type { AiConversationContextSnapshot, AiPermission } from "@/lib/ai-types";

import { AiActionProposals } from "./ai-action-proposals";
import { AiPermissionPicker } from "./ai-permission-picker";

interface AiChatPanelProps {
  projectId: string;
  taskId?: string;
  selectedTaskIds?: string[];
  title: string;
  onClose?: () => void;
}

interface PendingMessage {
  id: string;
  role: "user";
  content: string;
}

export function AiChatPanel({ projectId, taskId, selectedTaskIds = [], title, onClose }: AiChatPanelProps) {
  const utils = trpc.useUtils();
  const { data: permissions } = trpc.ai.listPermissions.useQuery();
  const { data: providers = [] } = trpc.ai.listProviders.useQuery({ projectId });
  const { data: policy } = trpc.ai.getProjectPolicy.useQuery({ projectId });
  const { data: currentUser } = trpc.user.me.useQuery();
  const { data: aiPreferences } = trpc.user.aiPreferences.useQuery();
  const historyInput = useMemo(
    () => ({ projectId, ...(taskId ? { taskId } : {}) }),
    [projectId, taskId]
  );
  const { data: conversations = [] } = trpc.ai.listConversations.useQuery(historyInput);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string>("");
  const [mode, setMode] = useState<"approval" | "yolo">("approval");
  const [grantedPermissions, setGrantedPermissions] = useState<AiPermission[]>([]);
  const [draftPermissions, setDraftPermissions] = useState<AiPermission[]>([]);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [sendOnEnter, setSendOnEnter] = useState<boolean | null>(null);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);

  const availablePermissions = useMemo(
    () => (permissions ?? []) as AiPermission[],
    [permissions]
  );

  const maxPermissions = useMemo(
    () => (Array.isArray(policy?.maxPermissions) ? (policy.maxPermissions as AiPermission[]) : availablePermissions),
    [availablePermissions, policy?.maxPermissions]
  );

  const effectiveSelectablePermissions = availablePermissions.filter((permission) => maxPermissions.includes(permission));
  const visibleProviders = useMemo(
    () => providers.filter((provider) => {
      if (!provider.isEnabled) {
        return false;
      }
      if (provider.scope === "user" && policy && !policy.allowUserProviders) {
        return false;
      }
      if (provider.scope === "project" && policy && !policy.allowProjectProviders) {
        return false;
      }
      return true;
    }),
    [policy, providers]
  );

  useEffect(() => {
    if (!providerId && visibleProviders.length > 0) {
      const defaultProvider = visibleProviders.find((provider) => provider.isDefault) ?? visibleProviders[0];
      setProviderId(defaultProvider.id);
    }
    if (providerId && visibleProviders.length > 0 && !visibleProviders.some((provider) => provider.id === providerId)) {
      setProviderId(visibleProviders[0].id);
    }
    if (providerId && visibleProviders.length === 0) {
      setProviderId("");
    }
  }, [providerId, visibleProviders]);

  useEffect(() => {
    const defaults = Array.isArray(policy?.defaultPermissions)
      ? (policy.defaultPermissions as AiPermission[])
      : (["read_current_task", "read_selected_tasks", "search_project"] as AiPermission[]);
    const nextPermissions = defaults.filter((permission) => maxPermissions.includes(permission));
    setGrantedPermissions(nextPermissions);
    setDraftPermissions(nextPermissions);
  }, [maxPermissions, policy?.defaultPermissions]);

  const { data: conversation } = trpc.ai.getConversation.useQuery(
    { id: conversationId ?? "" },
    { enabled: !!conversationId }
  );
  const contextSnapshot = conversation?.contextSnapshot as AiConversationContextSnapshot | undefined;

  const startConversation = trpc.ai.startConversation.useMutation({
    onSuccess: (createdConversation) => {
      setConversationId(createdConversation.id);
      utils.ai.getConversation.invalidate({ id: createdConversation.id });
      utils.ai.listConversations.invalidate(historyInput);
    },
  });

  const sendMessage = trpc.ai.sendMessage.useMutation({
    onSuccess: async (_data, variables) => {
      setErrorMessage(null);
      setMessage("");
      setPendingMessages([]);
      const id = variables.id;
      if (id) {
        await Promise.all([
          utils.ai.getConversation.invalidate({ id }),
          utils.ai.listActionExecutions.invalidate({ conversationId: id }),
          utils.ai.listConversations.invalidate(historyInput),
          utils.task.list.invalidate(),
          utils.task.links.invalidate({ projectId }),
          ...(taskId ? [utils.task.byId.invalidate({ id: taskId })] : []),
        ]);
      }
    },
    onError: async (error, variables) => {
      setErrorMessage(error.message);
      setPendingMessages([]);
      if (variables.id) {
        await utils.ai.getConversation.invalidate({ id: variables.id });
      }
    },
  });

  const approveAction = trpc.ai.approveAction.useMutation({
    onSuccess: async () => {
      setErrorMessage(null);
      if (conversationId) {
        await Promise.all([
          utils.ai.getConversation.invalidate({ id: conversationId }),
          utils.task.list.invalidate(),
          utils.task.links.invalidate({ projectId }),
          ...(taskId ? [utils.task.byId.invalidate({ id: taskId })] : []),
        ]);
      }
    },
    onError: (error) => setErrorMessage(error.message),
  });

  const rejectAction = trpc.ai.rejectAction.useMutation({
    onSuccess: async () => {
      setErrorMessage(null);
      if (conversationId) {
        await utils.ai.getConversation.invalidate({ id: conversationId });
      }
    },
    onError: (error) => setErrorMessage(error.message),
  });

  const updateAiPreferences = trpc.user.updateAiPreferences.useMutation({
    onSuccess: (savedPreferences) => {
      utils.user.aiPreferences.setData(undefined, savedPreferences);
    },
    onError: (error) => {
      setSendOnEnter(aiPreferences?.sendOnEnter ?? null);
      setErrorMessage(error.message);
    },
  });

  const rollbackAction = trpc.ai.rollbackAction.useMutation({
    onSuccess: async () => {
      setErrorMessage(null);
      if (conversationId) {
        await Promise.all([
          utils.ai.getConversation.invalidate({ id: conversationId }),
          utils.task.list.invalidate(),
          utils.task.links.invalidate({ projectId }),
          ...(taskId ? [utils.task.byId.invalidate({ id: taskId })] : []),
        ]);
      }
    },
    onError: (error) => setErrorMessage(error.message),
  });

  const generateConversationTitle = trpc.ai.generateConversationTitle.useMutation({
    onSuccess: async (updatedConversation) => {
      setErrorMessage(null);
      await Promise.all([
        utils.ai.getConversation.invalidate({ id: updatedConversation.id }),
        utils.ai.listConversations.invalidate(historyInput),
      ]);
    },
    onError: (error) => setErrorMessage(error.message),
  });

  const proposals = (conversation?.actionExecutions ?? []).map((proposal) => ({
    ...proposal,
    proposedPayload: proposal.proposedPayload as Record<string, unknown>,
  }));
  const messages = [
    ...((conversation?.messages ?? []).map((item) => ({
      id: item.id,
      role: item.role,
      content: item.content,
    }))),
    ...pendingMessages,
  ];

  const canUseYolo = policy?.allowYoloMode ?? true;
  const displayName = currentUser?.name?.trim() || currentUser?.email || "You";
  const effectiveSendOnEnter = sendOnEnter ?? aiPreferences?.sendOnEnter ?? false;
  const isThinking = sendMessage.isPending;
  const hasActiveConversation = Boolean(conversationId);
  const contextTasks = useMemo(() => {
    if (contextSnapshot?.currentTask) {
      return [contextSnapshot.currentTask, ...(contextSnapshot.selectedTasks ?? []), ...(contextSnapshot.projectTasks ?? [])];
    }
    if ((contextSnapshot?.selectedTasks?.length ?? 0) > 0) {
      return contextSnapshot?.selectedTasks ?? [];
    }
    return contextSnapshot?.projectTasks ?? [];
  }, [contextSnapshot]);
  const visibleContextTasks = contextTasks.slice(0, 12);

  useEffect(() => {
    if (!canUseYolo && mode === "yolo") {
      setMode("approval");
    }
  }, [canUseYolo, mode]);

  useEffect(() => {
    if (sendOnEnter === null && aiPreferences) {
      setSendOnEnter(aiPreferences.sendOnEnter);
    }
  }, [aiPreferences, sendOnEnter]);

  useEffect(() => {
    if (!conversation) {
      return;
    }

    setProviderId(conversation.providerId);
    setMode(conversation.mode === "yolo" && canUseYolo ? "yolo" : "approval");
    const conversationPermissions = Array.isArray(conversation.grantedPermissions)
      ? (conversation.grantedPermissions as AiPermission[])
      : [];
    const nextPermissions = conversationPermissions.filter((permission) => maxPermissions.includes(permission));
    setGrantedPermissions(nextPermissions);
    setDraftPermissions(nextPermissions);
  }, [canUseYolo, conversation, maxPermissions]);

  async function ensureConversation() {
    if (conversationId) {
      return conversationId;
    }

    const createdConversation = await startConversation.mutateAsync({
      projectId,
      taskId,
      providerId,
      title: message.trim().slice(0, 80),
      mode,
      grantedPermissions: draftPermissions.filter((permission) => maxPermissions.includes(permission)),
      selectedTaskIds,
    });
    return createdConversation.id;
  }

  function getMessageLabel(role: string) {
    if (role === "user") {
      return displayName;
    }
    if (role === "assistant") {
      return "Taskito AI";
    }
    return role;
  }

  function getConversationLabel(item: (typeof conversations)[number]) {
    const baseTitle = item.title?.trim() || `Conversation from ${new Date(item.updatedAt).toLocaleString()}`;
    return `${baseTitle} · ${item.provider.label}`;
  }

  function renderMessageContent(role: string, content: string) {
    if (role !== "assistant") {
      return <div className="whitespace-pre-wrap text-sm" style={{ color: "var(--color-text)" }}>{content}</div>;
    }

    return (
      <div className="text-sm leading-6" style={{ color: "var(--color-text)" }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            h1: ({ children }) => <h1 className="mb-3 mt-5 text-lg font-semibold">{children}</h1>,
            h2: ({ children }) => <h2 className="mb-3 mt-5 text-base font-semibold">{children}</h2>,
            h3: ({ children }) => <h3 className="mb-3 mt-5 text-base font-semibold">{children}</h3>,
            h4: ({ children }) => <h4 className="mb-2 mt-4 text-sm font-semibold">{children}</h4>,
            p: ({ children }) => <p className="my-3">{children}</p>,
            ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
            ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
            li: ({ children }) => <li className="leading-6">{children}</li>,
            strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
            em: ({ children }) => <em className="italic">{children}</em>,
            hr: () => <hr className="my-4 border-t" style={{ borderColor: "var(--color-border)" }} />,
            blockquote: ({ children }) => (
              <blockquote
                className="my-4 border-l-2 pl-4 italic"
                style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
              >
                {children}
              </blockquote>
            ),
            a: (props) => <a {...props} target="_blank" rel="noreferrer" className="underline underline-offset-2" />,
            code: ({ className, children, ...props }) => {
              if (!className) {
                return (
                  <code
                    {...props}
                    className="rounded px-1 py-0.5"
                    style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text)" }}
                  >
                    {children}
                  </code>
                );
              }

              return <code {...props} className={className}>{children}</code>;
            },
            pre: (props) => (
              <pre
                {...props}
                className="my-4 overflow-x-auto rounded-xl border p-3 text-xs leading-5"
                style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
              />
            ),
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    );
  }

  function startNewConversation() {
    setConversationId(null);
    setErrorMessage(null);
    setPendingMessages([]);
    setMode(mode === "yolo" && canUseYolo ? "yolo" : "approval");
    setGrantedPermissions(draftPermissions.filter((permission) => maxPermissions.includes(permission)));
    const defaultProvider = visibleProviders.find((provider) => provider.isDefault) ?? visibleProviders[0];
    setProviderId(defaultProvider?.id ?? "");
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" style={{ backgroundColor: "var(--color-surface)" }}>
      <div className="border-b p-4" style={{ borderColor: "var(--color-border)" }}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>{title}</h3>
            <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
              Ask questions about the current project, review proposed changes, and approve writes safely.
            </p>
          </div>
          {onClose && <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>}
        </div>
        <div className="mt-4 grid gap-4 xl:grid-cols-5">
          <div>
            <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Provider</label>
            <select
              value={providerId}
              onChange={(event) => setProviderId(event.target.value)}
              disabled={hasActiveConversation}
              className="h-9 w-full rounded-lg border px-3 text-sm"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
            >
              <option value="">Select provider...</option>
              {visibleProviders.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label} ({provider.scope})
                </option>
              ))}
            </select>
            {visibleProviders.length === 0 && (
              <p className="mt-1 text-xs" style={{ color: "var(--color-danger)" }}>
                No enabled provider is allowed by this project policy.
              </p>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Mode</label>
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as "approval" | "yolo")}
              disabled={hasActiveConversation}
              className="h-9 w-full rounded-lg border px-3 text-sm"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
            >
              <option value="approval">Approval mode</option>
              <option value="yolo" disabled={!canUseYolo}>Yolo mode</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Granted permissions</label>
            <AiPermissionPicker
              permissions={effectiveSelectablePermissions}
              value={(hasActiveConversation ? grantedPermissions : draftPermissions).filter((permission) => maxPermissions.includes(permission))}
              onChange={(nextPermissions) => {
                const filteredPermissions = nextPermissions.filter((permission) => maxPermissions.includes(permission));
                if (!hasActiveConversation) {
                  setDraftPermissions(filteredPermissions);
                }
                setGrantedPermissions(filteredPermissions);
              }}
              disabled={hasActiveConversation || startConversation.isPending || sendMessage.isPending}
              compact
            />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <label className="block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Chat history</label>
              <Button type="button" size="sm" variant="ghost" onClick={startNewConversation}>New</Button>
            </div>
            <select
              value={conversationId ?? ""}
              onChange={(event) => setConversationId(event.target.value || null)}
              className="h-9 w-full rounded-lg border px-3 text-sm"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
            >
              <option value="">Current draft / new chat</option>
              {conversations.map((item) => (
                <option key={item.id} value={item.id}>{getConversationLabel(item)}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Loaded context</label>
            <details className="relative">
              <summary
                className="flex h-9 cursor-pointer list-none items-center justify-between rounded-lg border px-3 text-sm"
                style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
              >
                <span>{contextTasks.length === 0 ? "No tasks loaded" : `${contextTasks.length} loaded task${contextTasks.length === 1 ? "" : "s"}`}</span>
                <span style={{ color: "var(--color-text-muted)" }}>v</span>
              </summary>
              <div
                className="absolute left-0 right-0 z-20 mt-2 max-h-80 overflow-y-auto rounded-2xl border p-3 shadow-xl"
                style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
              >
                {contextTasks.length === 0 ? (
                  <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
                    {taskId || selectedTaskIds.length > 0 ? "Task context will appear after the first reply in this conversation." : "Project task context will appear after the first reply in this conversation."}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {visibleContextTasks.map((task, index) => {
                      const taskId = typeof task.id === "string" ? task.id : `${index}`;
                      const key = typeof task.key === "string" ? task.key : null;
                      const taskTitle = typeof task.title === "string" ? task.title : "Untitled task";
                      return (
                        <div key={taskId} className="rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
                          <div className="font-medium" style={{ color: "var(--color-text)" }}>{key ?? "Task"}</div>
                          <div className="truncate">{taskTitle}</div>
                        </div>
                      );
                    })}
                    {contextTasks.length > visibleContextTasks.length && (
                      <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                        Showing {visibleContextTasks.length} of {contextTasks.length} loaded tasks.
                      </p>
                    )}
                  </div>
                )}
              </div>
            </details>
          </div>
        </div>
        {mode === "yolo" && (
          <div className="mt-4 rounded-2xl border p-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--color-warning) 35%, var(--color-border))", backgroundColor: "color-mix(in srgb, var(--color-warning) 10%, transparent)", color: "var(--color-text-secondary)" }}>
            Writes will auto-execute after proposal generation. Taskito still enforces auth and project policy.
          </div>
        )}
        {hasActiveConversation && (
          <p className="mt-3 text-xs" style={{ color: "var(--color-text-muted)" }}>
            Provider, mode, and permissions are locked to this conversation. Start a new chat to change them.
          </p>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {errorMessage && (
          <div className="mb-4 rounded-2xl border p-3 text-sm" style={{ borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))", color: "var(--color-danger)" }}>
            {errorMessage}
          </div>
        )}
        <div className="space-y-3">
          {messages.map((item) => (
            <div key={item.id} className="rounded-2xl border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: item.role === "assistant" ? "var(--color-bg-overlay)" : "var(--color-surface)" }}>
              <div className="mb-1 text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>{getMessageLabel(item.role)}</div>
              {renderMessageContent(item.role, item.content)}
            </div>
          ))}
          {isThinking && (
            <div className="rounded-2xl border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
              <div className="mb-1 text-xs font-semibold" style={{ color: "var(--color-text-muted)" }}>Taskito AI</div>
              <div className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
                <span className="inline-flex gap-1">
                  <span className="h-2 w-2 animate-pulse rounded-full" style={{ backgroundColor: "var(--color-accent)" }} />
                  <span className="h-2 w-2 animate-pulse rounded-full [animation-delay:120ms]" style={{ backgroundColor: "var(--color-accent)" }} />
                  <span className="h-2 w-2 animate-pulse rounded-full [animation-delay:240ms]" style={{ backgroundColor: "var(--color-accent)" }} />
                </span>
                Thinking...
              </div>
            </div>
          )}
        </div>

        <div className="mt-4">
          <AiActionProposals
            proposals={proposals}
            isPending={approveAction.isPending || rejectAction.isPending || rollbackAction.isPending}
            onApprove={(proposalId) => approveAction.mutate({ id: proposalId })}
            onReject={(proposalId) => rejectAction.mutate({ id: proposalId })}
            onRollback={(proposalId) => rollbackAction.mutate({ id: proposalId })}
          />
        </div>
      </div>

      <form
        className="border-t p-4"
        style={{ borderColor: "var(--color-border)" }}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!message.trim() || !providerId) {
            return;
          }

          try {
            setErrorMessage(null);
            const pendingContent = message.trim();
            setPendingMessages((current) => ([
              ...current,
              {
                id: `pending-${Date.now()}`,
                role: "user",
                content: pendingContent,
              },
            ]));
            const id = await ensureConversation();
            setConversationId(id);
            await sendMessage.mutateAsync({ id, content: pendingContent });
          } catch (error) {
            setErrorMessage(error instanceof Error ? error.message : "AI message failed");
          }
        }}
      >
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (effectiveSendOnEnter && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={3}
          placeholder={taskId ? "Ask about this task or propose a change..." : "Ask about the selected work or project..."}
          className="w-full rounded-2xl border px-3 py-2 text-sm"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
        />
        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
              Writes run as you. Approval is required unless Yolo mode is enabled.
            </span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={!conversationId || generateConversationTitle.isPending || sendMessage.isPending || startConversation.isPending}
              onClick={() => {
                if (!conversationId) {
                  return;
                }
                generateConversationTitle.mutate({ id: conversationId });
              }}
            >
              {generateConversationTitle.isPending ? "Generating title..." : "Generate title"}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-3 sm:justify-end">
            <label className="flex items-center gap-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>
              <input
                type="checkbox"
                checked={effectiveSendOnEnter}
                disabled={updateAiPreferences.isPending}
                onChange={(event) => {
                  const nextSendOnEnter = event.target.checked;
                  setSendOnEnter(nextSendOnEnter);
                  updateAiPreferences.mutate({ sendOnEnter: nextSendOnEnter });
                }}
              />
              Enter sends
            </label>
            <Button type="submit" disabled={sendMessage.isPending || startConversation.isPending || !providerId || !message.trim()}>
              {sendMessage.isPending ? "Thinking..." : "Send"}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
