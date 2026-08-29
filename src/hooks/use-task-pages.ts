"use client";

import { useEffect, useMemo, useRef, type RefObject } from "react";
import type { inferRouterInputs } from "@trpc/server";
import { trpc } from "@/lib/trpc-client";
import { flattenTaskPages } from "@/lib/task-pagination";
import type { AppRouter } from "@/server/routers/_app";
import type { TaskCardData } from "@/lib/types";

type RouterInputs = inferRouterInputs<AppRouter>;
type TaskListInput = RouterInputs["task"]["list"];

/** Filter input accepted by `useTaskPages` — same shape as the plain
 * `task.list` query input, with `limit` optional (defaults to 100) and
 * `cursor` managed internally by the infinite query. */
export type TaskPagesInput = Omit<TaskListInput, "cursor" | "limit"> & {
  limit?: number;
};

const DEFAULT_PAGE_LIMIT = 100;

/**
 * Cursor-paginated access to `task.list` for task views.
 *
 * Wraps `trpc.task.list.useInfiniteQuery` (tRPC v11 + TanStack Query v5) and
 * preserves the previous single-page behaviour: the input shape is unchanged
 * and `placeholderData` keeps the previous result visible while filters or
 * pages refetch.
 *
 * Query key notes:
 * - tRPC v11 stores infinite queries under `[['task','list'], { input: <input
 *   without cursor>, type: 'infinite' }]`, so `utils.task.list.invalidate()`
 *   (type `'any'`, prefix match) keeps invalidating these queries even though
 *   they are now infinite.
 * - `getData`/`setData` only target `type: 'query'` entries; use
 *   `utils.task.list.getInfiniteData`/`setInfiniteData` instead.
 */
export function useTaskPages(input: TaskPagesInput) {
  const queryInput = useMemo(
    () => ({
      limit: DEFAULT_PAGE_LIMIT,
      ...input,
    }),
    [input]
  );

  const query = trpc.task.list.useInfiniteQuery(queryInput, {
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    placeholderData: (previousData) => previousData,
  });

  const tasks = useMemo(
    () => flattenTaskPages(query.data?.pages) as unknown as TaskCardData[],
    [query.data]
  );

  const total = query.data?.pages[query.data.pages.length - 1]?.totalCount ?? null;

  return {
    tasks,
    isLoading: query.isLoading,
    error: query.error,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    /** Server-side count of tasks matching the current filters. */
    total,
    /** Number of tasks loaded so far across all fetched pages. */
    totalLoaded: tasks.length,
  };
}

/**
 * Auto-load sentinel: attaches an IntersectionObserver to the returned ref
 * and calls `onLoadMore` whenever the sentinel scrolls into view while
 * `enabled` is true. The "Load more" button remains as a visible fallback.
 */
export function useLoadMoreSentinel(
  onLoadMore: () => void,
  enabled: boolean
): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const onLoadMoreRef = useRef(onLoadMore);

  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !enabled || typeof IntersectionObserver === "undefined") {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin: "240px" }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled]);

  return sentinelRef;
}
