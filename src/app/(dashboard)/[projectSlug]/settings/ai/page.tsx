"use client";

import { use, useEffect, useMemo, useState } from "react";

import { AiPermissionPicker } from "@/components/ai/ai-permission-picker";
import { AiProviderForm } from "@/components/ai/ai-provider-form";
import { AiProviderList } from "@/components/ai/ai-provider-list";
import { Button } from "@/components/ui/button";
import { DialogControlled as Dialog, DialogContent } from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc-client";
import type { AiPermission } from "@/lib/ai-types";

export default function AiSettingsPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = use(params);
  const { data: project } = trpc.project.bySlug.useQuery({ slug: projectSlug });

  if (!project) {
    return <div className="p-8" style={{ color: "var(--color-text-muted)" }}>Loading...</div>;
  }

  return <AiSettingsContent projectId={project.id} projectName={project.name} />;
}

function AiSettingsContent({ projectId, projectName }: { projectId: string; projectName: string }) {
  const utils = trpc.useUtils();
  const policyQuery = trpc.ai.getProjectPolicy.useQuery({ projectId });
  const { data: permissions } = trpc.ai.listPermissions.useQuery();
  const { data: providers = [] } = trpc.ai.listProviders.useQuery({ projectId, actorScope: "manage" });
  const policy = policyQuery.data;
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<{ providerId: string; label: string; secret: string } | null>(null);
  const [defaultProviderId, setDefaultProviderId] = useState<string>("");
  const [allowUserProviders, setAllowUserProviders] = useState(true);
  const [allowProjectProviders, setAllowProjectProviders] = useState(true);
  const [allowSharedProviders, setAllowSharedProviders] = useState(true);
  const [allowYoloMode, setAllowYoloMode] = useState(false);
  const [defaultPermissions, setDefaultPermissions] = useState<AiPermission[]>([]);
  const [maxPermissions, setMaxPermissions] = useState<AiPermission[]>([]);

  const createMutation = trpc.ai.createProjectProvider.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.ai.listProviders.invalidate({ projectId, actorScope: "manage" }),
        utils.ai.getProjectPolicy.invalidate({ projectId }),
      ]);
    },
  });

  const updateMutation = trpc.ai.updateProvider.useMutation({
    onSuccess: async () => {
      setEditingProviderId(null);
      await Promise.all([
        utils.ai.listProviders.invalidate({ projectId, actorScope: "manage" }),
        utils.ai.getProjectPolicy.invalidate({ projectId }),
      ]);
    },
  });

  const deleteMutation = trpc.ai.deleteProvider.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.ai.listProviders.invalidate({ projectId, actorScope: "manage" }),
        utils.ai.getProjectPolicy.invalidate({ projectId }),
      ]);
    },
  });

  const aiClient = trpc.useContext();

  const savePolicyMutation = trpc.ai.updateProjectPolicy.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.ai.getProjectPolicy.invalidate({ projectId }),
        utils.ai.listProviders.invalidate({ projectId, actorScope: "manage" }),
      ]);
    },
  });

  const testMutation = trpc.ai.testProvider.useMutation();

  const projectProviders = providers.filter((provider) => provider.scope === "project") as Array<{
    id: string;
    label: string;
    adapter: string | null;
    model: string | null;
    baseUrl: string | null;
    isEnabled: boolean;
    isDefault: boolean;
    scope: "user" | "project" | "shared";
    canManage?: boolean;
  }>;
  const sharedProviders = providers.filter((provider) => provider.scope === "shared") as Array<{
    id: string;
    label: string;
    adapter: string | null;
    model: string | null;
    baseUrl: string | null;
    isEnabled: boolean;
    isDefault: boolean;
    scope: "user" | "project" | "shared";
    canManage?: boolean;
  }>;
  const policyDefaultCandidates = [...sharedProviders, ...projectProviders];
  const editingProvider = [...projectProviders, ...sharedProviders].find((provider) => provider.id === editingProviderId) ?? null;
  const availablePermissions = useMemo(() => (permissions ?? []) as AiPermission[], [permissions]);

  useEffect(() => {
    const fallbackPermissions = ["read_current_task", "read_selected_tasks", "search_project"] as AiPermission[];
    const nextMaxPermissions = Array.isArray(policy?.maxPermissions) ? (policy.maxPermissions as AiPermission[]) : availablePermissions;
    setDefaultProviderId(policy?.defaultProviderId ?? "");
    setAllowUserProviders(policy?.allowUserProviders ?? true);
    setAllowProjectProviders(policy?.allowProjectProviders ?? true);
    setAllowSharedProviders(policy?.allowSharedProviders ?? true);
    setAllowYoloMode(policy?.allowYoloMode ?? true);
    setMaxPermissions(nextMaxPermissions);
    setDefaultPermissions((Array.isArray(policy?.defaultPermissions) ? (policy.defaultPermissions as AiPermission[]) : fallbackPermissions)
      .filter((permission) => nextMaxPermissions.includes(permission)));
  }, [availablePermissions, policy]);

  if (policyQuery.error) {
    return <div className="p-8" style={{ color: "var(--color-danger)" }}>{policyQuery.error.message}</div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 lg:px-6">
      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
          Project AI
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>
          AI Settings For {projectName}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Control shared providers, permission ceilings, default conversation permissions, and whether this project allows Yolo mode.
        </p>
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <AiProviderForm
          title="Add Project Provider"
          submitLabel="Create Project Provider"
          isPending={createMutation.isPending}
          error={createMutation.error?.message ?? null}
          onSubmit={(values) => createMutation.mutate({ projectId, ...values })}
        />
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Project Providers</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Providers configured directly for this project.
        </p>
        <div className="mt-4">
          <AiProviderList
            providers={projectProviders}
            onEdit={(provider) => {
              setEditingProviderId(provider.id);
            }}
            onDelete={(provider) => {
              if (confirm(`Delete provider \"${provider.label}\"?`)) {
                deleteMutation.mutate({ id: provider.id });
              }
            }}
            onRevealSecret={async (provider) => {
              const result = await aiClient.ai.revealProviderSecret.fetch({ id: provider.id });
              setRevealedSecret({ providerId: provider.id, label: provider.label, secret: result.secret ?? "" });
            }}
            onTest={(provider) => testMutation.mutate({ id: provider.id })}
          />
        </div>
        {testMutation.error && (
          <p className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>{testMutation.error.message}</p>
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
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Shared Admin Providers</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Centrally managed providers that can be enabled for this project without exposing their configuration to non-admin users.
        </p>
        <div className="mt-4">
          <AiProviderList providers={sharedProviders} />
        </div>
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Project Policy</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Limit how AI can operate inside this project, even when a user has their own provider.
        </p>
        <div className="mt-5 space-y-5">
          <div>
            <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Default project provider</label>
            <select
              value={defaultProviderId}
              onChange={(event) => setDefaultProviderId(event.target.value)}
              className="h-9 w-full rounded-lg border px-3 text-sm"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
            >
              <option value="">No default</option>
              {policyDefaultCandidates.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.label}</option>
              ))}
            </select>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
              <input type="checkbox" checked={allowUserProviders} onChange={(event) => setAllowUserProviders(event.target.checked)} />
              Allow personal providers
            </label>
            <label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
              <input type="checkbox" checked={allowProjectProviders} onChange={(event) => setAllowProjectProviders(event.target.checked)} />
              Allow project providers
            </label>
            <label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
              <input type="checkbox" checked={allowSharedProviders} onChange={(event) => setAllowSharedProviders(event.target.checked)} />
              Allow shared providers
            </label>
            <label className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}>
              <input type="checkbox" checked={allowYoloMode} onChange={(event) => setAllowYoloMode(event.target.checked)} />
              Allow Yolo mode
            </label>
          </div>

          <div>
            <div className="mb-2 text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Default conversation permissions</div>
            <AiPermissionPicker
              permissions={maxPermissions}
              value={defaultPermissions}
              onChange={(nextPermissions) => setDefaultPermissions(nextPermissions.filter((permission) => maxPermissions.includes(permission)))}
            />
          </div>

          <div>
            <div className="mb-2 text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Maximum allowed permissions</div>
            <AiPermissionPicker
              permissions={availablePermissions}
              value={maxPermissions}
              onChange={(nextPermissions) => {
                setMaxPermissions(nextPermissions);
                setDefaultPermissions((current) => current.filter((permission) => nextPermissions.includes(permission)));
              }}
            />
          </div>

          {savePolicyMutation.error && (
            <p className="text-sm" style={{ color: "var(--color-danger)" }}>{savePolicyMutation.error.message}</p>
          )}

          <div className="flex justify-end">
            <Button
              disabled={savePolicyMutation.isPending}
              onClick={() =>
                savePolicyMutation.mutate({
                    projectId,
                    policy: {
                    defaultProviderId: defaultProviderId || null,
                    allowUserProviders,
                    allowProjectProviders,
                    allowSharedProviders,
                    allowYoloMode,
                    defaultPermissions: defaultPermissions.filter((permission) => maxPermissions.includes(permission)),
                    maxPermissions,
                  },
                })
              }
            >
              {savePolicyMutation.isPending ? "Saving..." : "Save Policy"}
            </Button>
          </div>
        </div>
      </section>

      <Dialog open={!!editingProvider} onOpenChange={(open) => {
        if (!open) {
          setEditingProviderId(null);
        }
      }}>
        <DialogContent>
          {editingProvider && (
            <AiProviderForm
              title="Edit Project Provider"
              submitLabel="Save Project Provider"
              isPending={updateMutation.isPending}
              error={updateMutation.error?.message ?? null}
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
    </div>
  );
}
