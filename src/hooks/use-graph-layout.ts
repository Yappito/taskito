"use client";

import { useState, useCallback, useMemo, useRef } from "react";
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
  const generationRef = useRef(0);
  const safeTasks = useMemo(() => tasks.filter(isValidGraphTask), [tasks]);

  const compute = useCallback(async () => {
    // Generation counter so a stale async layout can never overwrite a newer one
    const generation = ++generationRef.current;

    if (safeTasks.length === 0) {
      setLayout({ nodes: [], edges: [], width: 0, height: 0 });
      setIsComputing(false);
      return;
    }

    setIsComputing(true);
    try {
      const result = await computeGraphLayout({
        tasks: safeTasks,
        links,
        timeScale,
      });
      if (generation === generationRef.current) {
        setLayout(result);
      }
    } catch (err) {
      console.error("Graph layout failed:", err);
    } finally {
      if (generation === generationRef.current) {
        setIsComputing(false);
      }
    }
  }, [safeTasks, links, timeScale]);

  return { layout, isComputing, compute };
}
