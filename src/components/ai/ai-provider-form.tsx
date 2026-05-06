"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ProviderAdapter = "openai_compatible" | "anthropic";

interface AiProviderFormProps {
  title: string;
  submitLabel: string;
  isPending?: boolean;
  error?: string | null;
  secretRequired?: boolean;
  showDefaultToggle?: boolean;
  initialValues?: {
    label?: string;
    adapter?: ProviderAdapter;
    baseUrl?: string;
    model?: string;
    secret: string;
    isEnabled?: boolean;
    isDefault?: boolean;
  };
  onSubmit: (values: {
    label: string;
    adapter: ProviderAdapter;
    baseUrl: string;
    model: string;
    secret: string;
    isEnabled: boolean;
    isDefault: boolean;
  }) => void;
}

export function AiProviderForm({
  title,
  submitLabel,
  isPending = false,
  error,
  secretRequired = true,
  showDefaultToggle = true,
  initialValues,
  onSubmit,
}: AiProviderFormProps) {
  const [label, setLabel] = useState(initialValues?.label ?? "");
  const [adapter, setAdapter] = useState<ProviderAdapter>(initialValues?.adapter ?? "openai_compatible");
  const [baseUrl, setBaseUrl] = useState(initialValues?.baseUrl ?? "https://api.openai.com/v1");
  const [model, setModel] = useState(initialValues?.model ?? "");
  const [secret, setSecret] = useState(initialValues?.secret ?? "");
  const [isEnabled, setIsEnabled] = useState(initialValues?.isEnabled ?? true);
  const [isDefault, setIsDefault] = useState(initialValues?.isDefault ?? false);

  useEffect(() => {
    setLabel(initialValues?.label ?? "");
    setAdapter(initialValues?.adapter ?? "openai_compatible");
    setBaseUrl(initialValues?.baseUrl ?? "https://api.openai.com/v1");
    setModel(initialValues?.model ?? "");
    setSecret(initialValues?.secret ?? "");
    setIsEnabled(initialValues?.isEnabled ?? true);
    setIsDefault(initialValues?.isDefault ?? false);
  }, [initialValues]);

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({ label, adapter, baseUrl, model, secret, isEnabled, isDefault });
      }}
    >
      <div>
        <h3 className="text-base font-semibold" style={{ color: "var(--color-text)" }}>
          {title}
        </h3>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
            Label
          </label>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Claude Team Provider" required />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
            Adapter
          </label>
          <select
            value={adapter}
            onChange={(event) => setAdapter(event.target.value as ProviderAdapter)}
            className="h-9 w-full rounded-lg border px-3 text-sm"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
          >
            <option value="openai_compatible">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
          Base URL
        </label>
        <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" required />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
            Model
          </label>
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="gpt-4.1-mini" required />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
            API Key / Secret
          </label>
          <Input
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            placeholder={secretRequired ? "Paste secret" : "Leave blank to keep existing secret"}
            required={secretRequired}
          />
          {!secretRequired && (
            <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
              Enter a new value only when rotating this provider secret.
            </p>
          )}
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          <input type="checkbox" checked={isEnabled} onChange={(event) => setIsEnabled(event.target.checked)} />
          Enabled
        </label>
        {showDefaultToggle && (
          <label className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
            <input type="checkbox" checked={isDefault} onChange={(event) => setIsDefault(event.target.checked)} />
            Set as default
          </label>
        )}
      </div>
      {error && (
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
