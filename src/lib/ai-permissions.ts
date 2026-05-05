import { AI_PERMISSION_PRESETS, AI_PERMISSION_VALUES, type AiPermission, type AiPermissionPreset } from "@/lib/ai-types";

export function isAiPermission(value: string): value is AiPermission {
  return (AI_PERMISSION_VALUES as readonly string[]).includes(value);
}

export function normalizeAiPermissions(values: unknown): AiPermission[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return [...new Set(values.filter((value): value is AiPermission => typeof value === "string" && isAiPermission(value)))];
}

export function expandAiPermissionPreset(preset: AiPermissionPreset) {
  return [...AI_PERMISSION_PRESETS[preset]];
}

export function intersectAiPermissions(...permissionSets: Array<Iterable<AiPermission>>) {
  if (permissionSets.length === 0) {
    return [] as AiPermission[];
  }

  const [first, ...rest] = permissionSets.map((set) => new Set(set));
  return [...first].filter((permission) => rest.every((set) => set.has(permission)));
}
