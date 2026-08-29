"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";

import { AiProviderForm } from "@/components/ai/ai-provider-form";
import { AiProviderList } from "@/components/ai/ai-provider-list";
import { Alert, Button, useConfirm } from "@/components/ui";
import { DialogControlled as Dialog, DialogContent } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Provider row as returned by ai.listProviders (replaces the hand-written copy) */
export type AiProviderSummary = RouterOutputs["ai"]["listProviders"][number];

/** Either the caller's personal scope or a project scope */
export type ProviderManagerScope = "user" | { projectId: string };

interface ProviderManagerProps {
  scope: ProviderManagerScope;
  providers: AiProviderSummary[];
  /** Heading used for the edit dialog (single visible title, linked via aria-labelledby) */
  editTitle: string;
  editSubmitLabel: string;
  showDefaultToggle?: boolean;
}

function listInvalidationInput(scope: ProviderManagerScope) {
  return scope === "user"
    ? { actorScope: "manage" as const }
    : { projectId: scope.projectId, actorScope: "manage" as const };
}

/**
 * Shared AI provider management block: provider list with test/reveal/edit/
 * delete actions, the edit dialog and the revealed-secret panel. Used by the
 * personal AI settings tab (scope="user") and the per-project AI settings
 * page (scope={projectId}).
 */
export function ProviderManager({ scope, providers, editTitle, editSubmitLabel, showDefaultToggle = true }: ProviderManagerProps) {
  const utils = trpc.useUtils();
  const projectId = scope === "user" ? undefined : scope.projectId;
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ providerId: string; label: string; secret: string } | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();

  async function invalidateScope() {
    await utils.ai.listProviders.invalidate(listInvalidationInput(scope));
    if (projectId) {
      await utils.ai.getProjectPolicy.invalidate({ projectId });
    }
  }

  const updateMutation = trpc.ai.updateProvider.useMutation({
    onSuccess: async () => {
      setEditingProviderId(null);
      await invalidateScope();
    },
  });

  const deleteMutation = trpc.ai.deleteProvider.useMutation({
    onSuccess: async () => {
      setDeleteError(null);
      await invalidateScope();
    },
    onError: (error) => {
      setDeleteError(error.message);
    },
  });

  const testMutation = trpc.ai.testProvider.useMutation();

  const editingProvider = providers.find((provider) => provider.id === editingProviderId) ?? null;

  async function revealSecret(provider: { id: string; label: string }) {
    setRevealError(null);
    try {
      const result = await utils.ai.revealProviderSecret.fetch({ id: provider.id });
      setRevealedSecret({ providerId: provider.id, label: provider.label, secret: result.secret ?? "" });
    } catch (error) {
      setRevealedSecret(null);
      setRevealError(error instanceof Error ? error.message : "Unable to reveal provider secret");
    }
  }

  return (
    <>
      <AiProviderList
        providers={providers}
        onEdit={(provider) => {
          setEditingProviderId(provider.id);
        }}
        onDelete={(provider) => {
          void confirm({
            title: `Delete provider "${provider.label}"?`,
            confirmLabel: "Delete",
            destructive: true,
          }).then((confirmed) => {
            if (confirmed) {
              deleteMutation.mutate({ id: provider.id });
            }
          });
        }}
        onRevealSecret={(provider) => {
          void revealSecret(provider);
        }}
        onTest={(provider) => testMutation.mutate({ id: provider.id })}
      />
      {deleteError && (
        <Alert variant="danger" className="mt-3">{deleteError}</Alert>
      )}
      {revealError && (
        <Alert variant="danger" className="mt-3">{revealError}</Alert>
      )}
      {testMutation.error && (
        <p className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>
          {testMutation.error.message}
        </p>
      )}
      {testMutation.data && (
        <p className="mt-3 text-sm" style={{ color: "var(--color-accent)" }}>
          Provider test request succeeded for {testMutation.data.label}.
        </p>
      )}
      {revealedSecret && (
        <div className="mt-3 rounded-2xl border p-3 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
          <div className="font-medium" style={{ color: "var(--color-text)" }}>Secret for {revealedSecret.label}</div>
          <code className="mt-2 block overflow-x-auto rounded-xl px-3 py-2 text-xs" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text)" }}>
            {revealedSecret.secret}
          </code>
          <Button className="mt-3" size="sm" variant="outline" onClick={() => setRevealedSecret(null)}>Hide Secret</Button>
        </div>
      )}
      {confirmElement}
      <Dialog
        open={!!editingProvider}
        title={editTitle}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProviderId(null);
          }
        }}
      >
        <DialogContent>
          {editingProvider && (
            <AiProviderForm
              title={editTitle}
              showTitle={false}
              submitLabel={editSubmitLabel}
              isPending={updateMutation.isPending}
              error={updateMutation.error?.message ?? null}
              showDefaultToggle={showDefaultToggle}
              initialValues={{
                label: editingProvider.label,
                adapter: (editingProvider.adapter ?? "openai_compatible") as "openai_compatible" | "anthropic",
                baseUrl: editingProvider.baseUrl ?? "",
                model: editingProvider.model ?? "",
                secret: "",
                isEnabled: editingProvider.isEnabled,
                isDefault: editingProvider.isDefault,
              }}
              secretRequired={false}
              onSubmit={(values) => updateMutation.mutate({ id: editingProvider.id, ...values })}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
