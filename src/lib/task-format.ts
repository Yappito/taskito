/**
 * Pure formatting helpers shared by task UI surfaces (detail panel, cards, graph nodes).
 * Kept free of React/DOM so they are trivially unit-testable.
 */

/** Human description of a task activity event */
export function describeActivityEvent(event: { action: string; details?: Record<string, unknown> | null }) {
  switch (event.action) {
    case "created":
      return "created this task";
    case "updated": {
      const changedFields = Array.isArray(event.details?.changedFields)
        ? event.details.changedFields.filter((field): field is string => typeof field === "string")
        : [];
      return changedFields.length > 0
        ? `updated ${changedFields.join(", ")}`
        : "updated this task";
    }
    case "bulkUpdated":
      return "applied a bulk update";
    case "commented":
      return "added a comment";
    case "archived":
      return "archived this task";
    case "unarchived":
      return "restored this task";
    case "duplicated":
      return "created this task by duplicating another one";
    default:
      return event.action;
  }
}

/** Warning messages for incomplete dependencies/children of a task */
export function getDependencyMessages(task: {
  dependencyState?: {
    blockingTaskCount: number;
    openChildCount: number;
  };
}) {
  const messages: string[] = [];

  if ((task.dependencyState?.blockingTaskCount ?? 0) > 0) {
    messages.push(`Blocked by ${task.dependencyState!.blockingTaskCount} incomplete prerequisite${task.dependencyState!.blockingTaskCount === 1 ? "" : "s"}`);
  }

  if ((task.dependencyState?.openChildCount ?? 0) > 0) {
    messages.push(`${task.dependencyState!.openChildCount} child task${task.dependencyState!.openChildCount === 1 ? " is" : "s are"} still open`);
  }

  return messages;
}

/** Consistent error text for failed task mutations */
export function getMutationErrorMessage(error: { message?: string } | null) {
  return error?.message || "Unable to save task changes.";
}

/** Human-readable byte size (B / KB / MB) */
export function formatBytes(sizeBytes: number) {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}