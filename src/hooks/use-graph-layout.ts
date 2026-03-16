"use client";

import { useState, useCallback, useMemo } from "react";
import { computeGraphLayout } from "@/lib/elk-config";
import type { GraphLayout, GraphTaskData } from "@/lib/types";

interface UseGraphLayoutParams {
  tasks: GraphTaskData[];
  links: Array<{
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    linkType: string;
  }>;
  timeScale: (date: Date) => number;
}

function isValidGraphTask(task: GraphTaskData | null | undefined): task is GraphTaskData {
  if (!task) {
    return false;
  }

  return !Number.isNaN(new Date(task.dueDate).getTime());
}

/** Hook to compute and cache ELK graph layout */
export function useGraphLayout({ tasks, links, timeScale }: UseGraphLayoutParams) {
  const [layout, setLayout] = useState<GraphLayout | null>(null);
  const [isComputing, setIsComputing] = useState(false);
  const safeTasks = useMemo(() => tasks.filter(isValidGraphTask), [tasks]);

  // Memoize the key to detect when recomputation is needed
  const layoutKey = useMemo(
    () =>
      JSON.stringify({
        tasks: safeTasks
          .map((t) => ({ id: t.id, dueDate: t.dueDate, statusId: t.statusId }))
          .sort((a, b) => a.id.localeCompare(b.id)),
        links: links
          .map((l) => ({ id: l.id, sourceTaskId: l.sourceTaskId, targetTaskId: l.targetTaskId }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }),
    [safeTasks, links]
  );

  const compute = useCallback(async () => {
    if (safeTasks.length === 0) {
      setLayout({ nodes: [], edges: [], width: 0, height: 0 });
      return;
    }

    setIsComputing(true);
    try {
      const result = await computeGraphLayout({
        tasks: safeTasks,
        links,
        timeScale,
      });
      setLayout(result);
    } catch (err) {
      console.error("Graph layout failed:", err);
    } finally {
      setIsComputing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- layoutKey is a stable serialization of tasks+links
  }, [layoutKey, safeTasks, links, timeScale]);

  return { layout, isComputing, compute };
}
