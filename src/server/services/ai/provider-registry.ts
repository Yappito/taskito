import type { AiProviderConnection } from "@prisma/client";

import { decryptAiSecret } from "@/lib/ai-crypto";

export interface ResolvedAiProvider {
  id: string;
  adapter: AiProviderConnection["adapter"];
  baseUrl: string;
  model: string;
  secret: string;
  defaultHeaders: Record<string, string>;
  /**
   * Optional per-provider settings bag (`settings.maxOutputTokens`,
   * `settings.temperature`). The current `AiProviderConnection` table has no
   * settings column, so this is normally empty; it stays wired through the
   * registry so adapters read a single typed accessor.
   */
  settings: Record<string, unknown>;
}

function readProviderSettings(record: Pick<AiProviderConnection, "id" | "adapter" | "baseUrl" | "model" | "encryptedSecret" | "defaultHeaders">) {
  const raw = (record as { settings?: unknown }).settings;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return raw as Record<string, unknown>;
}

export function resolveAiProvider(provider: Pick<AiProviderConnection, "id" | "adapter" | "baseUrl" | "model" | "encryptedSecret" | "defaultHeaders">) {
  return {
    id: provider.id,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    model: provider.model,
    secret: decryptAiSecret(provider.encryptedSecret),
    defaultHeaders: (provider.defaultHeaders ?? {}) as Record<string, string>,
    settings: readProviderSettings(provider),
  } satisfies ResolvedAiProvider;
}