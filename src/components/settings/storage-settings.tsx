"use client";

import type { inferRouterOutputs } from "@trpc/server";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { trpc } from "@/lib/trpc-client";
import { useState } from "react";
import type { AppRouter } from "@/server/routers/_app";

type RouterOutputs = inferRouterOutputs<AppRouter>;

/** Serialized storage config as returned by storage.get */
export type StorageConfigSummary = NonNullable<RouterOutputs["storage"]["get"]["effective"]>;

type StorageProvider = StorageConfigSummary["provider"];

export interface StorageSettingsFormData {
  provider: StorageProvider;
  s3Bucket: string;
  s3Region: string;
  s3Endpoint: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3SessionToken: string;
  s3ForcePathStyle: boolean;
  s3Prefix: string;
  clearS3SessionToken: boolean;
}

export const emptyStorageSettingsForm: StorageSettingsFormData = {
  provider: "local",
  s3Bucket: "",
  s3Region: "us-east-1",
  s3Endpoint: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  s3SessionToken: "",
  s3ForcePathStyle: false,
  s3Prefix: "",
  clearS3SessionToken: false,
};

/** Maps a serialized storage config into editable form state (secrets stay write-only) */
export function storageConfigToForm(config: StorageConfigSummary | null): StorageSettingsFormData {
  if (!config) return emptyStorageSettingsForm;

  return {
    provider: config.provider,
    s3Bucket: config.s3Bucket ?? "",
    s3Region: config.s3Region ?? "us-east-1",
    s3Endpoint: config.s3Endpoint ?? "",
    s3AccessKeyId: config.s3AccessKeyId ?? "",
    s3SecretAccessKey: "",
    s3SessionToken: "",
    s3ForcePathStyle: config.s3ForcePathStyle,
    s3Prefix: config.s3Prefix ?? "",
    clearS3SessionToken: false,
  };
}

/** Human summary of a storage config for the Active/Override/Environment cards */
export function describeStorageConfig(config: StorageConfigSummary | null) {
  if (!config) return "No environment storage override configured.";
  if (config.provider === "local") return `Local uploads (${config.source})`;
  return `S3 bucket ${config.s3Bucket}${config.s3Prefix ? ` / ${config.s3Prefix}` : ""} (${config.source})`;
}

/** Storage tab (admin): current storage configs and the override form */
export function StorageSettings() {
  const { data, isLoading } = trpc.storage.get.useQuery();

  if (isLoading) {
    return (
      <div className="animate-pulse py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
        Loading storage settings...
      </div>
    );
  }

  const effective = data?.effective ?? null;
  const database = data?.database ?? null;
  const environment = data?.environment ?? null;
  const activeFormSource = database ?? effective;

  return (
    <StorageSettingsForm
      // Remount with fresh values whenever the persisted config actually changes,
      // instead of an effect that clobbers in-progress edits on every refetch.
      key={JSON.stringify(activeFormSource)}
      effective={effective}
      database={database}
      environment={environment}
      initialForm={storageConfigToForm(activeFormSource)}
    />
  );
}

function StorageSettingsForm({
  effective,
  database,
  environment,
  initialForm,
}: {
  effective: StorageConfigSummary | null;
  database: StorageConfigSummary | null;
  environment: StorageConfigSummary | null;
  initialForm: StorageSettingsFormData;
}) {
  const utils = trpc.useUtils();
  const [form, setForm] = useState<StorageSettingsFormData>(initialForm);

  const saveMutation = trpc.storage.save.useMutation({
    onSuccess: async () => {
      await utils.storage.get.invalidate();
      setForm((current) => ({ ...current, s3SecretAccessKey: "", s3SessionToken: "", clearS3SessionToken: false }));
    },
  });

  const clearMutation = trpc.storage.clearOverride.useMutation({
    onSuccess: async () => {
      await utils.storage.get.invalidate();
    },
  });

  const hasRetainedSecret = database?.hasS3SecretAccessKey || (!database && effective?.hasS3SecretAccessKey);

  return (
    <div className="space-y-6">
      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
          File storage
        </p>
        <h2 className="mt-2 text-xl font-semibold" style={{ color: "var(--color-text)" }}>
          Attachments and Images
        </h2>
        <p className="mt-2 text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Store uploads locally or in an S3-compatible bucket. Downloads still pass through authenticated Taskito routes.
        </p>
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>Active</div>
          <div className="mt-2 font-medium" style={{ color: "var(--color-text)" }}>{describeStorageConfig(effective)}</div>
        </div>
        <div className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>UI Override</div>
          <div className="mt-2 font-medium" style={{ color: "var(--color-text)" }}>{database ? describeStorageConfig(database) : "None"}</div>
        </div>
        <div className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <div className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>Environment</div>
          <div className="mt-2 font-medium" style={{ color: "var(--color-text)" }}>{describeStorageConfig(environment)}</div>
        </div>
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            saveMutation.mutate(form);
          }}
        >
          <Field label="Storage Backend">
            {(ids) => (
              <Select id={ids.id}
                value={form.provider}
                onChange={(event) => setForm((current) => ({ ...current, provider: event.target.value as StorageProvider }))}
              >
                <option value="local">Local uploads volume</option>
                <option value="s3">S3 bucket</option>
              </Select>
            )}
          </Field>

          {form.provider === "s3" && (
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Bucket" required>
                {(ids) => (
                  <Input id={ids.id} value={form.s3Bucket} onChange={(event) => setForm((current) => ({ ...current, s3Bucket: event.target.value }))} required />
                )}
              </Field>
              <Field label="Region">
                {(ids) => (
                  <Input id={ids.id} value={form.s3Region} onChange={(event) => setForm((current) => ({ ...current, s3Region: event.target.value }))} placeholder="us-east-1" />
                )}
              </Field>
              <Field label="Endpoint">
                {(ids) => (
                  <Input id={ids.id} value={form.s3Endpoint} onChange={(event) => setForm((current) => ({ ...current, s3Endpoint: event.target.value }))} placeholder="https://s3.amazonaws.com or MinIO URL" />
                )}
              </Field>
              <Field label="Object Key Prefix">
                {(ids) => (
                  <Input id={ids.id} value={form.s3Prefix} onChange={(event) => setForm((current) => ({ ...current, s3Prefix: event.target.value }))} placeholder="taskito/prod" />
                )}
              </Field>
              <Field label="Access Key ID">
                {(ids) => (
                  <Input id={ids.id} value={form.s3AccessKeyId} onChange={(event) => setForm((current) => ({ ...current, s3AccessKeyId: event.target.value }))} placeholder="Optional when using IAM role/default credentials" />
                )}
              </Field>
              <Field label="Secret Access Key">
                {(ids) => (
                  <Input id={ids.id} type="password" value={form.s3SecretAccessKey} onChange={(event) => setForm((current) => ({ ...current, s3SecretAccessKey: event.target.value }))} placeholder={hasRetainedSecret ? "Leave blank to keep saved secret" : "Write-only secret"} />
                )}
              </Field>
              <Field label="Session Token">
                {(ids) => (
                  <Input id={ids.id} type="password" value={form.s3SessionToken} onChange={(event) => setForm((current) => ({ ...current, s3SessionToken: event.target.value }))} placeholder={database?.hasS3SessionToken ? "Leave blank to keep saved token" : "Optional write-only token"} />
                )}
              </Field>
              <label className="flex items-center gap-3 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text)", backgroundColor: "var(--color-bg-overlay)" }}>
                <input
                  type="checkbox"
                  checked={form.s3ForcePathStyle}
                  onChange={(event) => setForm((current) => ({ ...current, s3ForcePathStyle: event.target.checked }))}
                  className="accent-[var(--color-accent)]"
                />
                Force path-style URLs for S3-compatible services
              </label>
              {database?.hasS3SessionToken && (
                <label className="flex items-center gap-3 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text)", backgroundColor: "var(--color-bg-overlay)" }}>
                  <input
                    type="checkbox"
                    checked={form.clearS3SessionToken}
                    onChange={(event) => setForm((current) => ({ ...current, clearS3SessionToken: event.target.checked }))}
                    className="accent-[var(--color-accent)]"
                  />
                  Clear saved session token
                </label>
              )}
            </div>
          )}

          {saveMutation.error && <p className="text-sm" style={{ color: "var(--color-danger)" }}>{saveMutation.error.message}</p>}
          {clearMutation.error && <p className="text-sm" style={{ color: "var(--color-danger)" }}>{clearMutation.error.message}</p>}
          {saveMutation.isSuccess && <p className="text-sm" style={{ color: "var(--color-accent)" }}>Storage settings saved.</p>}

          <div className="flex flex-wrap justify-end gap-2">
            {database && (
              <Button type="button" variant="outline" disabled={clearMutation.isPending} onClick={() => clearMutation.mutate()}>
                {clearMutation.isPending ? "Clearing..." : "Clear UI Override"}
              </Button>
            )}
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Saving..." : "Save Storage Settings"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
