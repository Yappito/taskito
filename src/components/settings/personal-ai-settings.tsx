"use client";

import { ProviderManager, type AiProviderSummary } from "@/components/ai/provider-manager";
import { AiProviderForm } from "@/components/ai/ai-provider-form";
import { trpc } from "@/lib/trpc-client";

/** Personal AI tab: personal providers plus (for admins) shared providers */
export function PersonalAiSettings({ currentUserRole }: { currentUserRole: string }) {
  const utils = trpc.useUtils();
  const isAdmin = currentUserRole === "admin";
  const { data: providers = [] } = trpc.ai.listProviders.useQuery({ actorScope: "manage" });

  const createMutation = trpc.ai.createUserProvider.useMutation({
    onSuccess: async () => {
      await utils.ai.listProviders.invalidate({ actorScope: "manage" });
    },
  });

  const createSharedMutation = trpc.ai.createSharedProvider.useMutation({
    onSuccess: async () => {
      await utils.ai.listProviders.invalidate({ actorScope: "manage" });
    },
  });

  const personalProviders = providers.filter((provider) => provider.scope === "user") as AiProviderSummary[];
  const sharedProviders = providers.filter((provider) => provider.scope === "shared") as AiProviderSummary[];

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
          Personal AI
        </p>
        <h2 className="mt-2 text-xl font-semibold" style={{ color: "var(--color-text)" }}>
          Personal Providers
        </h2>
        <p className="mt-2 text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Configure private remote AI providers that only you can use inside projects that allow personal providers.
        </p>
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <AiProviderForm
          title="Add Personal Provider"
          submitLabel="Create Provider"
          isPending={createMutation.isPending}
          error={createMutation.error?.message ?? null}
          onSubmit={(values) => createMutation.mutate(values)}
        />
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          Configured Personal Providers
        </h2>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          These providers are scoped to your account only.
        </p>
        <div className="mt-4">
          <ProviderManager
            scope="user"
            providers={personalProviders}
            editTitle="Edit Personal Provider"
            editSubmitLabel="Save Provider"
          />
        </div>
      </section>

      {isAdmin && (
        <>
          <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
            <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
              Shared AI
            </p>
            <h2 className="mt-2 text-xl font-semibold" style={{ color: "var(--color-text)" }}>
              Admin Shared Providers
            </h2>
            <p className="mt-2 text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
              Configure centrally managed providers that can be enabled per project without exposing their configuration to regular users.
            </p>
          </section>

          <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
            <AiProviderForm
              title="Add Shared Provider"
              submitLabel="Create Shared Provider"
              isPending={createSharedMutation.isPending}
              error={createSharedMutation.error?.message ?? null}
              showDefaultToggle={false}
              onSubmit={(values) => createSharedMutation.mutate(values)}
            />
          </section>

          <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
            <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
              Configured Shared Providers
            </h2>
            <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
              These providers can be made available across projects through project AI policy.
            </p>
            <div className="mt-4">
              <ProviderManager
                scope="user"
                providers={sharedProviders}
                editTitle="Edit Shared Provider"
                editSubmitLabel="Save Shared Provider"
                showDefaultToggle={false}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}
