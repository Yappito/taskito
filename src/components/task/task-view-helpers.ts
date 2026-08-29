/**
 * Pure helpers shared by the task view controls (board/list/cards).
 * Kept free of DOM/event wiring so they are trivially unit-testable.
 */
import type { CSSProperties } from "react";
import { getTagChipStyle } from "@/components/ui/tag-badge";

export type TaskSortField = "dueDate" | "title" | "priority";
export type TaskSortDirection = "asc" | "desc";

/** aria-sort value for a sortable list header */
export function ariaSortFor(
  field: TaskSortField,
  activeField: TaskSortField,
  activeDir: TaskSortDirection
): "ascending" | "descending" | "none" {
  if (field !== activeField) return "none";
  return activeDir === "asc" ? "ascending" : "descending";
}

/**
 * True when a keyboard event inside a task card targets an interactive
 * descendant (controls like the Move-to select handle Space/Enter themselves).
 */
export function isInteractiveCardTarget(target: EventTarget | null, root: EventTarget | null): boolean {
  if (target === root) return false;
  const element = target as HTMLElement | null;
  if (element && typeof element.closest === "function") {
    return Boolean(element.closest("input, select, textarea, button, a, [role='button']"));
  }
  return false;
}

/** Toggle chip style for tag chips: selected state uses the tag's own colour */
export function getTagToggleChipStyle(
  selected: boolean,
  color: string | null | undefined
): CSSProperties {
  if (!selected) {
    return {
      backgroundColor: "var(--color-surface)",
      borderColor: "var(--color-border)",
      color: "var(--color-text-secondary)",
    };
  }
  return { ...getTagChipStyle(color), borderColor: color ?? "var(--color-accent)" };
}