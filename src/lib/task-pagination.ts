/**
 * Pure helpers backing paginated task views (cursor pagination via `task.list`).
 * Kept free of React/tRPC imports so they are trivially unit-testable.
 */

interface TaskPage<TTask> {
  items: TTask[];
}

/**
 * Flatten infinite-query pages into a single de-duplicated task list.
 * Deduping by id guards against overlapping pages (e.g. a task moving
 * across the `dueDate` ordering boundary between two fetches).
 */
export function flattenTaskPages<TTask extends { id: string }>(
  pages: Array<TaskPage<TTask>> | undefined
): TTask[] {
  if (!pages || pages.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const tasks: TTask[] = [];

  for (const page of pages) {
    for (const task of page.items) {
      if (seen.has(task.id)) {
        continue;
      }
      seen.add(task.id);
      tasks.push(task);
    }
  }

  return tasks;
}

/**
 * "Showing N of M" formatter for sticky pagination footers.
 * When the server-side total is unknown (first page still loading),
 * falls back to "Showing N".
 */
export function formatShowingCount(
  totalLoaded: number,
  total: number | null | undefined
): string {
  if (total == null) {
    return `Showing ${totalLoaded}`;
  }
  return `Showing ${totalLoaded} of ${total}`;
}

/**
 * Whether more matching tasks exist server-side than are currently loaded.
 */
export function hasUnloadedTasks(
  totalLoaded: number,
  total: number | null | undefined
): boolean {
  return total != null && totalLoaded < total;
}

/**
 * Per-column truncation notice for the board view. Loading more tasks is a
 * global operation, so every column shows the same notice whenever the
 * loaded set is smaller than the total number of matching tasks — any column
 * may be missing cards that a further page would reveal.
 */
export function boardColumnTruncationNotice(
  totalLoaded: number,
  total: number | null | undefined
): string | null {
  if (total == null || totalLoaded >= total) {
    return null;
  }
  return `Showing first ${totalLoaded} of ${total} tasks — more ${total - totalLoaded === 1 ? "task is" : "tasks are"} in other pages.`;
}

/**
 * Message for single-page views (calendar/gantt) that cap at one page.
 */
export function firstPageTruncationMessage(
  totalLoaded: number,
  total: number | null | undefined
): string | null {
  if (!hasUnloadedTasks(totalLoaded, total)) {
    return null;
  }
  return `Showing first ${totalLoaded} of ${total} tasks.`;
}
