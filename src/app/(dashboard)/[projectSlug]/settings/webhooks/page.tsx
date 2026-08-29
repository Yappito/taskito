"use client";

import { use, useState, type FormEvent } from "react";
import Link from "next/link";

import { trpc } from "@/lib/trpc-client";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Skeleton, SkeletonGroup } from "@/components/ui/skeleton";

const EVENT_LABELS: Record<string, string> = {
  "task.created": "Task created",
  "task.updated": "Task updated",
  "task.status_changed": "Status changed",
  "task.assigned": "Task assigned",
  "task.archived": "Task archived",
  "task.deleted": "Task deleted",
  "comment.created": "Comment created",
  "comment.updated": "Comment updated",
};

const STATUS_TOKENS: Record<string, { color: string }> = {
  pending: { color: "var(--color-warning)" },
  success: { color: "var(--color-success)" },
  failed: { color: "var(--color-danger)" },
};

function formatDateTime(value: string | Date | null | undefined) {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export default function WebhookSettingsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = use(params);
  const { data: project, isLoading } = trpc.project.bySlug.useQuery({ slug: projectSlug });

  if (isLoading) {
    return (
      <div className="mx-auto max-w-5xl space-y-4 p-4 lg:p-6">
        <Skeleton className="h-8 w-64" />
        <SkeletonGroup>
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-64 w-full" />
        </SkeletonGroup>
      </div>
    );
  }
  if (!project) return <div className="p-6">Project not found</div>;

  return <WebhookSettingsContent projectId={project.id} projectSlug={projectSlug} />;
}

function WebhookSettingsContent({ projectId, projectSlug }: { projectId: string; projectSlug: string }) {
  const utils = trpc.useUtils();
  const { confirm, confirmElement } = useConfirm();
  const { data: webhooks = [], isLoading } = trpc.webhook.list.useQuery({ projectId });
  const { data: deliveries = [] } = trpc.webhook.listDeliveries.useQuery(
    { projectId, take: 25 },
    { enabled: !!projectId },
  );

  const [formError, setFormError] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["task.created", "task.status_changed"]);
  const [newUrl, setNewUrl] = useState("");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);

  const invalidate = () => {
    utils.webhook.list.invalidate({ projectId });
    utils.webhook.listDeliveries.invalidate({ projectId });
  };

  const createWebhook = trpc.webhook.create.useMutation({
    onSuccess: (webhook) => {
      setFormError(null);
      setCreatedSecret(webhook.secret);
      setNewUrl("");
      invalidate();
    },
    onError: (error) => setFormError(error.message),
  });
  const updateWebhook = trpc.webhook.update.useMutation({ onSuccess: invalidate });
  const deleteWebhook = trpc.webhook.delete.useMutation({ onSuccess: invalidate });
  const testDelivery = trpc.webhook.testDelivery.useMutation({ onSuccess: invalidate });
  const redeliver = trpc.webhook.redeliver.useMutation({ onSuccess: invalidate });

  function toggleEvent(event: string) {
    setSelectedEvents((current) =>
      current.includes(event) ? current.filter((entry) => entry !== event) : [...current, event],
    );
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreatedSecret(null);
    if (selectedEvents.length === 0) {
      setFormError("Subscribe the webhook to at least one event");
      return;
    }
    setFormError(null);
    createWebhook.mutate({
      projectId,
      url: newUrl.trim(),
      events: selectedEvents as never,
      isEnabled: true,
    });
  }

  async function handleDelete(id: string) {
    const confirmed = await confirm({
      title: "Delete this webhook?",
      description: "Pending deliveries will be removed and the signing secret becomes unusable.",
      confirmLabel: "Delete webhook",
      destructive: true,
    });
    if (confirmed) {
      deleteWebhook.mutate({ id });
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={{ color: "var(--color-text)" }}>Outbound webhooks</h1>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
            Push signed task events to Slack, n8n, Matrix, or your own endpoint. Deliveries are HMAC-signed and retried automatically.
          </p>
        </div>
        <Link href={`/${projectSlug}`} className="text-sm underline" style={{ color: "var(--color-accent)" }}>Back to project</Link>
      </div>

      {formError && <Alert variant="danger" role="alert">{formError}</Alert>}

      {createdSecret && (
        <Alert variant="success" title="Webhook created">
          Copy the signing secret now — it is shown only once:
          <code className="mt-2 block break-all rounded-lg px-3 py-2 font-mono text-xs" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text)" }}>
            {createdSecret}
          </code>
        </Alert>
      )}

      <form onSubmit={handleCreate} className="grid gap-4 rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <Field label="Payload URL" hint="Public HTTPS endpoints are recommended; private addresses are blocked unless the server sets WEBHOOK_ALLOW_PRIVATE_HOSTS=true.">
          <Input value={newUrl} onChange={(event) => setNewUrl(event.target.value)} placeholder="https://hooks.example.com/taskito" required />
        </Field>
        <Field label="Subscribe to events" htmlFor="webhook-events">
          <div id="webhook-events" className="grid gap-2 sm:grid-cols-2">
            {WEBHOOK_EVENTS.map((event) => (
              <label key={event} className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={selectedEvents.includes(event)}
                  onChange={() => toggleEvent(event)}
                  className="h-4 w-4"
                />
                <span className="font-mono text-xs">{event}</span>
                <span style={{ color: "var(--color-text-muted)" }}>{EVENT_LABELS[event]}</span>
              </label>
            ))}
          </div>
        </Field>
        <Button type="submit" disabled={createWebhook.isPending}>Create webhook</Button>
      </form>

      <section className="space-y-3">
        {isLoading ? (
          <SkeletonGroup>
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </SkeletonGroup>
        ) : (
          <>
            {webhooks.length === 0 ? (
              <EmptyState
                title="No webhooks yet"
                description="Create a webhook above to start receiving signed JSON events whenever tasks and comments change."
              />
            ) : (
              webhooks.map((webhook) => (
                <div key={webhook.id} className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm" style={{ color: "var(--color-text)" }}>{webhook.url}</p>
                      <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                        {webhook.events.join(", ")} · created {formatDateTime(webhook.createdAt)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" disabled={testDelivery.isPending} onClick={() => testDelivery.mutate({ id: webhook.id })}>
                        Send test
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => updateWebhook.mutate({ id: webhook.id, isEnabled: !webhook.isEnabled })}>
                        {webhook.isEnabled ? "Disable" : "Enable"}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => handleDelete(webhook.id)}>Delete</Button>
                    </div>
                  </div>
                  {testDelivery.data && (
                    <Alert
                      className="mt-3"
                      variant={testDelivery.data.status === "success" ? "success" : "danger"}
                    >
                      Test delivery {testDelivery.data.status}
                      {testDelivery.data.responseCode != null ? ` — HTTP ${testDelivery.data.responseCode}` : ""}
                      {testDelivery.data.error ? ` — ${testDelivery.data.error}` : ""}
                    </Alert>
                  )}
                </div>
              ))
            )}
          </>
        )}
      </section>

      <section className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h2 className="font-semibold" style={{ color: "var(--color-text)" }}>Delivery log</h2>
        <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
          Last 25 deliveries across all webhooks. Failed deliveries retry after 1m, then 5m (up to 3 attempts).
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
                <th className="px-2 py-2">Event</th>
                <th className="px-2 py-2">Status</th>
                <th className="px-2 py-2">Code</th>
                <th className="px-2 py-2">Attempts</th>
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {deliveries.map((delivery) => {
                const token = STATUS_TOKENS[delivery.status] ?? { color: "var(--color-text)" };
                return (
                  <tr key={delivery.id} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                    <td className="px-2 py-2 font-mono text-xs" style={{ color: "var(--color-text)" }}>{delivery.event}</td>
                    <td className="px-2 py-2 text-xs font-semibold capitalize" style={{ color: token.color }}>
                      {delivery.status}
                    </td>
                    <td className="px-2 py-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>{delivery.responseCode ?? "—"}</td>
                    <td className="px-2 py-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>{delivery.attempts}</td>
                    <td className="px-2 py-2 text-xs" style={{ color: "var(--color-text-secondary)" }}>{formatDateTime(delivery.createdAt)}</td>
                    <td className="px-2 py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={redeliver.isPending}
                        onClick={() => redeliver.mutate({ id: delivery.id })}
                      >
                        Redeliver
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {deliveries.length === 0 && (
            <p className="py-4 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>No deliveries recorded yet.</p>
          )}
        </div>
      </section>

      {confirmElement}
    </div>
  );
}