"use client";

import { Button } from "@/components/ui/button";

interface AiProviderListItem {
  id: string;
  label: string;
  adapter: string;
  model: string;
  baseUrl: string;
  isEnabled: boolean;
  isDefault: boolean;
  scope: "user" | "project";
}

interface AiProviderListProps {
  providers: AiProviderListItem[];
  onEdit: (provider: AiProviderListItem) => void;
  onDelete: (provider: AiProviderListItem) => void;
  onRevealSecret?: (provider: AiProviderListItem) => void;
  onTest?: (provider: AiProviderListItem) => void;
}

export function AiProviderList({ providers, onEdit, onDelete, onRevealSecret, onTest }: AiProviderListProps) {
  if (providers.length === 0) {
    return (
      <p className="rounded-2xl border px-4 py-6 text-center text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text-muted)" }}>
        No AI providers configured yet.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {providers.map((provider) => (
        <div
          key={provider.id}
          className="rounded-2xl border p-4"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}
        >
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium" style={{ color: "var(--color-text)" }}>{provider.label}</span>
                <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-secondary)" }}>
                  {provider.scope}
                </span>
                {provider.isDefault && (
                  <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-accent-muted)", color: "var(--color-accent)" }}>
                    default
                  </span>
                )}
                {!provider.isEnabled && (
                  <span className="rounded-full px-2 py-0.5 text-xs" style={{ backgroundColor: "var(--color-danger-muted)", color: "var(--color-danger)" }}>
                    disabled
                  </span>
                )}
              </div>
              <div className="mt-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
                {provider.adapter} · {provider.model}
              </div>
              <div className="mt-1 truncate text-xs" style={{ color: "var(--color-text-muted)" }}>
                {provider.baseUrl}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {onTest && <Button variant="outline" size="sm" onClick={() => onTest(provider)}>Test</Button>}
              {onRevealSecret && <Button variant="outline" size="sm" onClick={() => onRevealSecret(provider)}>Reveal Secret</Button>}
              <Button variant="outline" size="sm" onClick={() => onEdit(provider)}>Edit</Button>
              <Button variant="destructive" size="sm" onClick={() => onDelete(provider)}>Delete</Button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
