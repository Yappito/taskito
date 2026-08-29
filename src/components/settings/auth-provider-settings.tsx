"use client";

import { useEffect, useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import { Alert, Button, useConfirm } from "@/components/ui";
import { DialogControlled as Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc-client";
import type { AppRouter } from "@/server/routers/_app";
import { useCrudDialogs } from "@/hooks/use-crud-dialogs";
import {
  OidcProviderForm,
  callbackUrl,
  emptyOidcProvider,
  parseAdminEmailText,
  type OidcProviderFormData,
} from "@/components/settings/oidc-provider-form";

type RouterOutputs = inferRouterOutputs<AppRouter>;
type OidcProviderSummary = RouterOutputs["oidc"]["list"]["providers"][number];

/** Auth tab (admin): environment + UI-managed OIDC providers */
export function AuthProviderSettings() {
  const utils = trpc.useUtils();
  const { data, isLoading } = trpc.oidc.list.useQuery();
  const [origin, setOrigin] = useState("");
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();
  const dialogs = useCrudDialogs<OidcProviderSummary, OidcProviderFormData>({
    createForm: emptyOidcProvider,
    editForm: emptyOidcProvider,
  });

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const createMutation = trpc.oidc.create.useMutation({
    onSuccess: async () => {
      await utils.oidc.list.invalidate();
      dialogs.completeCreate();
    },
  });
  const updateMutation = trpc.oidc.update.useMutation({
    onSuccess: async () => {
      await utils.oidc.list.invalidate();
      dialogs.completeEdit();
    },
  });
  const deleteMutation = trpc.oidc.delete.useMutation({
    onSuccess: async () => {
      setDeleteError(null);
      await utils.oidc.list.invalidate();
    },
    onError: (error) => {
      setDeleteError(error.message);
    },
  });

  function toMutationInput(values: OidcProviderFormData) {
    return {
      providerId: values.providerId,
      name: values.name,
      issuer: values.issuer,
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      scope: values.scope,
      groupsClaim: values.groupsClaim,
      defaultRole: values.defaultRole,
      allowSignup: values.allowSignup,
      allowEmailAccountLinking: values.allowEmailAccountLinking,
      requireEmailVerified: values.requireEmailVerified,
      adminEmails: parseAdminEmailText(values.adminEmails),
      isEnabled: values.isEnabled,
    };
  }

  function openEdit(provider: OidcProviderSummary) {
    dialogs.openEdit(provider, {
      providerId: provider.providerId,
      name: provider.name,
      issuer: provider.issuer,
      clientId: provider.clientId,
      clientSecret: "",
      scope: provider.scope,
      groupsClaim: provider.groupsClaim,
      defaultRole: provider.defaultRole,
      allowSignup: provider.allowSignup,
      allowEmailAccountLinking: provider.allowEmailAccountLinking,
      requireEmailVerified: provider.requireEmailVerified,
      adminEmails: provider.adminEmails.join("\n"),
      isEnabled: provider.isEnabled,
    });
  }

  if (isLoading) {
    return (
      <div className="animate-pulse py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
        Loading auth providers...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
              Authentication
            </p>
            <h2 className="mt-2 text-xl font-semibold" style={{ color: "var(--color-text)" }}>
              OIDC Providers
            </h2>
            <p className="mt-2 text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
              Configure OIDC sign-in and group claim syncing. Client secrets are write-only and cannot be retrieved from the UI or browser console after saving.
            </p>
          </div>
          <Button onClick={dialogs.openCreate}>Add OIDC Provider</Button>
        </div>
      </section>

      {data?.envProviders.length ? (
        <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <h3 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Environment Providers</h3>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
            These providers are still loaded from environment variables and are read-only here.
          </p>
          <div className="mt-4 space-y-2">
            {data.envProviders.map((provider) => (
              <div key={provider.providerId} className="rounded-xl border p-4 text-sm" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
                <div className="font-medium" style={{ color: "var(--color-text)" }}>{provider.name}</div>
                <div className="mt-1" style={{ color: "var(--color-text-secondary)" }}>{provider.providerId} · {provider.issuer}</div>
                <div className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>Callback: {callbackUrl(origin, provider.providerId)}</div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h3 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Saved Providers</h3>
        <div className="mt-4 space-y-2">
          {data?.providers.map((provider) => (
            <div key={provider.id} className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium" style={{ color: "var(--color-text)" }}>{provider.name}</span>
                  <span className="rounded px-1.5 py-0.5 text-xs" style={{ backgroundColor: provider.isEnabled ? "var(--color-accent-muted)" : "var(--color-bg-muted)", color: provider.isEnabled ? "var(--color-accent)" : "var(--color-text-muted)" }}>
                    {provider.isEnabled ? "enabled" : "disabled"}
                  </span>
                </div>
                <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>{provider.providerId} · {provider.issuer}</p>
                <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  groups: {provider.groupsClaim} · callback: {callbackUrl(origin, provider.providerId)} · secret saved: {provider.hasClientSecret ? "yes" : "no"}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => openEdit(provider)}>Edit</Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    void confirm({
                      title: "Delete this OIDC provider?",
                      description: "Existing linked accounts are not deleted.",
                      confirmLabel: "Delete",
                      destructive: true,
                    }).then((confirmed) => {
                      if (confirmed) {
                        deleteMutation.mutate({ id: provider.id });
                      }
                    });
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
          {data?.providers.length === 0 && (
            <div className="py-10 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
              No UI-managed OIDC providers yet.
            </div>
          )}
        </div>
        {deleteError && (
          <Alert variant="danger" className="mt-3">{deleteError}</Alert>
        )}
      </section>

      <Dialog open={dialogs.createOpen} onOpenChange={(open) => { if (!open) dialogs.closeCreate(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add OIDC Provider</DialogTitle></DialogHeader>
          <OidcProviderForm
            value={dialogs.createForm}
            onChange={dialogs.setCreateForm}
            origin={origin}
            isPending={createMutation.isPending}
            error={createMutation.error?.message ?? null}
            onCancel={dialogs.closeAll}
            onSubmit={() => {
              // The typed secret is only cleared once the mutation succeeds
              // (completeCreate resets the form) so a failed submit keeps it.
              createMutation.mutate(toMutationInput(dialogs.createForm));
            }}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={dialogs.editOpen} onOpenChange={(open) => { if (!open) dialogs.closeEdit(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit OIDC Provider</DialogTitle></DialogHeader>
          {dialogs.editing && (
            <OidcProviderForm
              value={dialogs.editForm}
              onChange={dialogs.setEditForm}
              isEdit
              origin={origin}
              isPending={updateMutation.isPending}
              error={updateMutation.error?.message ?? null}
              onCancel={dialogs.closeAll}
              onSubmit={() => {
                const editing = dialogs.editing;
                if (!editing) return;
                updateMutation.mutate({
                  id: editing.id,
                  ...toMutationInput(dialogs.editForm),
                  clientSecret: dialogs.editForm.clientSecret.trim() || undefined,
                });
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      {confirmElement}
    </div>
  );
}
