import type { AiProviderConnection } from "@prisma/client";

import { decryptAiSecret } from "@/lib/ai-crypto";

export interface ResolvedAiProvider {
  id: string;
  adapter: AiProviderConnection["adapter"];
  baseUrl: string;
  model: string;
  secret: string;
  defaultHeaders: Record<string, string>;
}

export function resolveAiProvider(provider: Pick<AiProviderConnection, "id" | "adapter" | "baseUrl" | "model" | "encryptedSecret" | "defaultHeaders">) {
  return {
    id: provider.id,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    model: provider.model,
    secret: decryptAiSecret(provider.encryptedSecret),
    defaultHeaders: (provider.defaultHeaders ?? {}) as Record<string, string>,
  } satisfies ResolvedAiProvider;
}
