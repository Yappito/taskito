/**
 * Pure helpers for managing "list of selected ids" state (checkbox groups,
 * membership pickers, ...).
 */

/** Returns a new array with `id` toggled in or out of `ids` */
export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((existing) => existing !== id) : [...ids, id];
}
