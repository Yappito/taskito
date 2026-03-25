"use client";

import { useRef, useState, useEffect, useMemo, useCallback } from "react";

import { trpc } from "@/lib/trpc-client";
import { useTimelineZoom } from "@/hooks/use-timeline-zoom";
import { useGraphLayout } from "@/hooks/use-graph-layout";
import { TimeAxis } from "./time-axis";
import { TaskNode } from "./task-node";
import { DependencyEdge } from "./dependency-edge";
import { getAlertConfig, getAlertLevel } from "@/lib/alert-utils";
import { MiniMap } from "./mini-map";
import { TaskDetail } from "@/components/task/task-detail";
import { LinkTypePopup } from "@/components/ui/link-type-popup";
import { TaskViewFilters } from "@/components/task/task-view-filters";
import { createTimeScale } from "@/lib/date-utils";
import { getDateRange } from "@/lib/date-utils";
import type { TimeResolution, Viewport, LinkType, GraphTaskData, TaskFilterTagOption } from "@/lib/types";
import { cn } from "@/lib/utils";

interface TimelineGraphProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string; category?: string }>;
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

const AXIS_OFFSET = 50;
const MAX_GRAPH_SPAN_DAYS = 540;

const RESOLUTION_PIXELS_PER_DAY: Record<TimeResolution, number> = {
  day: 48,
  week: 18,
  month: 5,
  quarter: 2,
  year: 0.9,
};

function hasValidTaskDate(value: unknown) {
  if (!(value instanceof Date) && typeof value !== "string") {
    return false;
  }

  return !Number.isNaN(new Date(value).getTime());
}

function isGraphTaskItem(item: unknown): item is GraphTaskData & {
  status: GraphTaskData["status"];
  tags: GraphTaskData["tags"];
} {
  if (!item || typeof item !== "object") {
    return false;
  }

  const candidate = item as Partial<GraphTaskData>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.priority === "string" &&
    typeof candidate.statusId === "string" &&
    !!candidate.status &&
    Array.isArray(candidate.tags) &&
    hasValidTaskDate(candidate.dueDate)
  );
}

function getGraphWidth(
  start: Date,
  end: Date,
  resolution: TimeResolution,
  containerWidth: number
): number {
  const spanDays = Math.max(
    1,
    Math.ceil((end.getTime() - start.getTime()) / 86_400_000)
  );
  const widthFromResolution = spanDays * RESOLUTION_PIXELS_PER_DAY[resolution];
  return Math.max(containerWidth * 1.25, widthFromResolution + 320);
}

function getFocusedTaskIds(
  rootTaskId: string,
  links: Array<{ sourceTaskId: string; targetTaskId: string; linkType: string }>
): Set<string> {
  const includedTaskIds = new Set<string>([rootTaskId]);
  const traversedTaskIds = new Set<string>([rootTaskId]);
  const queue = [rootTaskId];

  while (queue.length > 0) {
    const currentTaskId = queue.shift()!;

    for (const link of links) {
      if (link.sourceTaskId !== currentTaskId && link.targetTaskId !== currentTaskId) {
        continue;
      }

      const neighborTaskId =
        link.sourceTaskId === currentTaskId ? link.targetTaskId : link.sourceTaskId;

      includedTaskIds.add(neighborTaskId);

      if (link.linkType === "relates" || traversedTaskIds.has(neighborTaskId)) {
        continue;
      }

      traversedTaskIds.add(neighborTaskId);
      queue.push(neighborTaskId);
    }
  }

  return includedTaskIds;
}

/** Main timeline-graph component: DAG nodes on a time axis */
export function TimelineGraph({ projectId, statuses, tags, projectSettings }: TimelineGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [resolution, setResolution] = useState<TimeResolution>("week");
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<string[]>([]);
  const [dimensions, setDimensions] = useState({ width: 1200, height: 600 });
  const previousFullViewRef = useRef<{ x: number; y: number; k: number } | null>(null);

  // ─── Linking state ──────────────────────────────────
  const [linkingFrom, setLinkingFrom] = useState<string | null>(null);
  const [linkingSide, setLinkingSide] = useState<"left" | "right">("right");
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);
  const [pendingLink, setPendingLink] = useState<{
    sourceId: string;
    targetId: string;
    screenX: number;
    screenY: number;
  } | null>(null);

  const { transform, resetZoom, zoomTo, zoomBy } = useTimelineZoom(svgRef);

  const alertConfig = useMemo(() => getAlertConfig(projectSettings), [projectSettings]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [search]);

  const utils = trpc.useUtils();
  const { data: people } = trpc.project.people.useQuery({ projectId });
  const { data: presets = [] } = trpc.project.filterPresets.useQuery({ projectId });

  // Fetch tasks and links
  const { data: taskData } = trpc.task.list.useQuery({
    projectId,
    limit: 100,
  });

  const { data: linksData } = trpc.task.links.useQuery({ projectId });

  const addLink = trpc.task.addLink.useMutation({
    onSuccess: () => {
      utils.task.links.invalidate({ projectId });
    },
  });

  const savePreset = trpc.project.saveFilterPreset.useMutation({
    onSuccess: () => {
      utils.project.filterPresets.invalidate({ projectId });
    },
  });

  const deletePreset = trpc.project.deleteFilterPreset.useMutation({
    onSuccess: () => {
      utils.project.filterPresets.invalidate({ projectId });
    },
  });

  const tasks: GraphTaskData[] = useMemo(() => {
    const items = taskData?.items;
    if (!items) return [];
    return items.filter(isGraphTaskItem).map((item) => ({
      id: item.id,
      title: item.title,
      priority: item.priority,
      dueDate: item.dueDate,
      startDate: "startDate" in item ? item.startDate ?? null : null,
      statusId: item.statusId,
      status: item.status,
      tags: item.tags,
      creator: item.creator,
      assignee: item.assignee,
      alertAcknowledged: (item as { alertAcknowledged?: boolean }).alertAcknowledged ?? false,
      dependencyState: item.dependencyState,
    }));
  }, [taskData?.items]);
  const allLinks = useMemo(() => {
    const taskIds = new Set(tasks.map((task) => task.id));
    return (linksData ?? []).filter(
      (link) => taskIds.has(link.sourceTaskId) && taskIds.has(link.targetTaskId)
    );
  }, [linksData, tasks]);

  const matchingTaskIds = useMemo(() => {
    const normalizedSearch = debouncedSearch.trim().toLowerCase();

    return new Set(
      tasks
        .filter((task) => {
          const matchesSearch =
            normalizedSearch.length === 0 || task.title.toLowerCase().includes(normalizedSearch);
          const matchesTags =
            selectedTagIds.length === 0 ||
            task.tags.some((taskTag) => selectedTagIds.includes(taskTag.tag.id));
          const matchesAssignee =
            selectedAssigneeIds.length === 0 ||
            (!!task.assignee && selectedAssigneeIds.includes(task.assignee.id));
          return matchesSearch && matchesTags && matchesAssignee;
        })
        .map((task) => task.id)
    );
  }, [tasks, debouncedSearch, selectedTagIds, selectedAssigneeIds]);

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  }

  function clearFilters() {
    setSearch("");
    setSelectedTagIds([]);
    setSelectedAssigneeIds([]);
  }

  function toggleAssignee(assigneeId: string) {
    setSelectedAssigneeIds((prev) =>
      prev.includes(assigneeId)
        ? prev.filter((id) => id !== assigneeId)
        : [...prev, assigneeId]
    );
  }

  const focusedGraph = useMemo(() => {
    if (!focusedTaskId) {
      return { tasks, links: allLinks };
    }

    const connectedTaskIds = getFocusedTaskIds(focusedTaskId, allLinks);

    return {
      tasks: tasks.filter((task) => connectedTaskIds.has(task.id)),
      links: allLinks.filter(
        (link) => connectedTaskIds.has(link.sourceTaskId) && connectedTaskIds.has(link.targetTaskId)
      ),
    };
  }, [focusedTaskId, tasks, allLinks]);

  const focusedTask = useMemo(
    () => tasks.find((task) => task.id === focusedTaskId) ?? null,
    [tasks, focusedTaskId]
  );

  // Compute date range and time scale
  const dateRange = useMemo(
    () => getDateRange(focusedGraph.tasks, 14, MAX_GRAPH_SPAN_DAYS),
    [focusedGraph.tasks]
  );
  const graphWidth = useMemo(
    () => getGraphWidth(dateRange.start, dateRange.end, resolution, dimensions.width),
    [dateRange, resolution, dimensions.width]
  );

  const timeScale = useMemo(
    () => createTimeScale(dateRange.start, dateRange.end, graphWidth),
    [dateRange, graphWidth]
  );

  // Compute layout
  const { layout, isComputing, compute } = useGraphLayout({
    tasks: focusedGraph.tasks,
    links: focusedGraph.links,
    timeScale,
  });

  // Recompute layout when tasks change
  useEffect(() => {
    compute();
  }, [compute]);

  useEffect(() => {
    if (!focusedTaskId || !layout || layout.nodes.length === 0) return;

    const padding = 72;
    const bounds = layout.nodes.reduce(
      (acc, node) => ({
        minX: Math.min(acc.minX, node.x),
        minY: Math.min(acc.minY, node.y),
        maxX: Math.max(acc.maxX, node.x + node.width),
        maxY: Math.max(acc.maxY, node.y + node.height),
      }),
      {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
      }
    );

    const contentWidth = Math.max(bounds.maxX - bounds.minX + padding * 2, 1);
    const contentHeight = Math.max(bounds.maxY - bounds.minY + padding * 2 + AXIS_OFFSET, 1);
    const scale = Math.min(
      2.2,
      Math.max(
        0.7,
        Math.min(dimensions.width / contentWidth, dimensions.height / contentHeight)
      )
    );

    const targetX = -(bounds.minX - padding) * scale;
    const targetY = -(bounds.minY + AXIS_OFFSET - padding) * scale;
    zoomTo(targetX, targetY, scale, { animate: false });
  }, [focusedTaskId, layout, dimensions, zoomTo]);

  // Measure container
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // ─── Linking drag handler ───────────────────────────
  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!linkingFrom) return;
      const rect = e.currentTarget.getBoundingClientRect();
      setMousePos({
        x: (e.clientX - rect.left - transform.x) / transform.k,
        y: (e.clientY - rect.top - transform.y) / transform.k,
      });
    },
    [linkingFrom, transform]
  );

  const handleSvgMouseUp = useCallback(() => {
    setLinkingFrom(null);
    setMousePos(null);
  }, []);

  const handlePortDragStart = useCallback((nodeId: string, side: "left" | "right") => {
    setLinkingFrom(nodeId);
    setLinkingSide(side);
  }, []);

  const handlePortDrop = useCallback(
    (targetId: string, event?: React.MouseEvent) => {
      if (!linkingFrom || linkingFrom === targetId) return;
      // Show link type popup at cursor position
      const rect = containerRef.current?.getBoundingClientRect();
      const screenX = event ? event.clientX - (rect?.left ?? 0) : 200;
      const screenY = event ? event.clientY - (rect?.top ?? 0) : 200;
      setPendingLink({
        sourceId: linkingFrom,
        targetId,
        screenX,
        screenY,
      });
      setLinkingFrom(null);
      setMousePos(null);
    },
    [linkingFrom]
  );

  const handleLinkTypeSelect = useCallback(
    (selectedLinkType: LinkType) => {
      if (!pendingLink) return;
      addLink.mutate({
        sourceTaskId: pendingLink.sourceId,
        targetTaskId: pendingLink.targetId,
        linkType: selectedLinkType,
      });
      setPendingLink(null);
    },
    [pendingLink, addLink]
  );

  // Viewport for culling and minimap
  const viewport: Viewport = useMemo(
    () => ({
      x: transform.x,
      y: transform.y,
      width: dimensions.width,
      height: dimensions.height,
      scale: transform.k,
    }),
    [transform, dimensions]
  );

  // Viewport culling: only render nodes/edges within visible area + buffer
  const visibleNodes = useMemo(() => {
    if (!layout) return [];
    const buffer = 200;
    const viewLeft = -transform.x / transform.k - buffer;
    const viewRight = viewLeft + dimensions.width / transform.k + buffer * 2;
    const viewTop = -transform.y / transform.k - buffer;
    const viewBottom = viewTop + dimensions.height / transform.k + buffer * 2;

    return layout.nodes.filter(
      (node) =>
        node.x + node.width >= viewLeft &&
        node.x <= viewRight &&
        node.y + node.height >= viewTop &&
        node.y <= viewBottom
    );
  }, [layout, transform, dimensions]);

  // Find source node anchor for the in-progress link
  const linkingSourcePos = useMemo(() => {
    if (!linkingFrom || !layout) return null;
    const node = layout.nodes.find((n) => n.id === linkingFrom);
    if (!node) return null;
    return {
      x: linkingSide === "left" ? node.x : node.x + node.width,
      y: node.y + AXIS_OFFSET + node.height / 2,
    };
  }, [linkingFrom, linkingSide, layout]);

  const handleNavigate = useCallback(
    (x: number, y: number) => {
      zoomTo(x, y, undefined, { durationMs: 140 });
    },
    [zoomTo]
  );

  const handleTaskClick = useCallback(
    (taskId: string) => {
      if (linkingFrom) return;

      if (focusedTaskId === taskId) {
        setFocusedTaskId(null);
        const previousView = previousFullViewRef.current;
        if (previousView) {
          zoomTo(previousView.x, previousView.y, previousView.k, { animate: false });
        }
        previousFullViewRef.current = null;
        return;
      }

      if (!focusedTaskId) {
        previousFullViewRef.current = {
          x: transform.x,
          y: transform.y,
          k: transform.k,
        };
      }

      setFocusedTaskId(taskId);
    },
    [focusedTaskId, linkingFrom, transform, zoomTo]
  );

  const resolutions: TimeResolution[] = ["day", "week", "month", "quarter", "year"];

  return (
    <div
      ref={containerRef}
      className="relative h-[calc(100vh-8rem)] w-full overflow-hidden"
      style={{ backgroundColor: "var(--color-bg-graph)" }}
    >
      {/* Toolbar */}
      <div
        className="absolute left-4 top-4 z-10 flex items-center gap-2 rounded-xl p-1.5 backdrop-blur-md"
        style={{
          backgroundColor: "var(--color-bg-overlay)",
          boxShadow: "var(--shadow-md)",
          border: "1px solid var(--color-border)",
        }}
      >
        {resolutions.map((r) => (
          <button
            key={r}
            onClick={() => setResolution(r)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-xs capitalize transition-all",
              resolution === r ? "font-semibold" : ""
            )}
            style={
              resolution === r
                ? {
                    backgroundColor: "var(--color-accent-muted)",
                    color: "var(--color-accent)",
                  }
                : { color: "var(--color-text-secondary)" }
            }
          >
            {r}
          </button>
        ))}
        <div
          className="mx-1 h-4 w-px"
          style={{ backgroundColor: "var(--color-border)" }}
        />
        <button
          onClick={() => resetZoom()}
          className="rounded-lg px-2.5 py-1 text-xs transition-colors"
          style={{ color: "var(--color-text-secondary)" }}
        >
          Reset
        </button>
        <button
          onClick={() => zoomBy(1.2, { durationMs: 100 })}
          className="rounded-lg px-2.5 py-1 text-xs transition-colors"
          style={{ color: "var(--color-text-secondary)" }}
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          onClick={() => zoomBy(1 / 1.2, { durationMs: 100 })}
          className="rounded-lg px-2.5 py-1 text-xs transition-colors"
          style={{ color: "var(--color-text-secondary)" }}
          aria-label="Zoom out"
        >
          -
        </button>
        {focusedTask && (
          <>
            <div
              className="mx-1 h-4 w-px"
              style={{ backgroundColor: "var(--color-border)" }}
            />
            <span
              className="max-w-48 truncate px-2 text-xs font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Focus: {focusedTask.title}
            </span>
            <button
              onClick={() => handleTaskClick(focusedTask.id)}
              className="rounded-lg px-2.5 py-1 text-xs transition-colors"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Show all
            </button>
          </>
        )}
      </div>

      <TaskViewFilters
        search={search}
        selectedTagIds={selectedTagIds}
        selectedAssigneeIds={selectedAssigneeIds}
        tags={tags}
        assignees={people ?? []}
        onSearchChange={setSearch}
        onToggleTag={toggleTag}
        onToggleAssignee={toggleAssignee}
        onClear={clearFilters}
        presets={presets as Array<{ id: string; name: string; search: string; tagIds: string[]; assigneeIds: string[] }>}
        onApplyPreset={(preset) => {
          setSearch(preset.search);
          setSelectedTagIds(preset.tagIds);
          setSelectedAssigneeIds(preset.assigneeIds);
        }}
        onSavePreset={(name) => {
          savePreset.mutate({
            projectId,
            preset: {
              id: crypto.randomUUID(),
              name,
              search,
              tagIds: selectedTagIds,
              assigneeIds: selectedAssigneeIds,
            },
          });
        }}
        onDeletePreset={(presetId) => deletePreset.mutate({ projectId, presetId })}
        searchPlaceholder="Highlight by title..."
        helperText="Matching tasks are highlighted and all other tasks remain visible."
        className="absolute left-4 top-20 z-10 w-[min(32rem,calc(100%-2rem))]"
      />

      {/* Loading indicator */}
      {isComputing && (
        <div
          className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-xs"
          style={{
            backgroundColor: "var(--color-accent-muted)",
            color: "var(--color-accent)",
          }}
        >
          Computing layout...
        </div>
      )}

      {/* Linking mode banner */}
      {linkingFrom && (
        <div
          className="absolute left-1/2 bottom-16 z-10 -translate-x-1/2 rounded-full px-4 py-1.5 text-xs font-medium"
          style={{
            backgroundColor: "var(--color-accent)",
            color: "white",
            boxShadow: "var(--shadow-md)",
          }}
        >
          Drop on a task to create a link — ESC to cancel
        </div>
      )}

      {/* Transparent overlay to capture mouse events during linking (D3 zoom consumes them on the SVG) */}
      {linkingFrom && (
        <div
          className="absolute inset-0 z-[5]"
          style={{ cursor: "crosshair" }}
          onMouseMove={(e) => {
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect) return;
            setMousePos({
              x: (e.clientX - rect.left - transform.x) / transform.k,
              y: (e.clientY - rect.top - transform.y) / transform.k,
            });
          }}
          onMouseUp={(e) => {
            // Check if we're over a target node
            const svgEl = svgRef.current;
            if (svgEl) {
              // Temporarily hide overlay to hit-test SVG elements beneath
              const overlay = e.currentTarget;
              overlay.style.pointerEvents = "none";
              const el = document.elementFromPoint(e.clientX, e.clientY);
              overlay.style.pointerEvents = "auto";
              const nodeEl = el?.closest?.(".graph-node");
              if (nodeEl) {
                const targetId = nodeEl.getAttribute("data-task-id");
                if (targetId && targetId !== linkingFrom) {
                  const rect = containerRef.current?.getBoundingClientRect();
                  setPendingLink({
                    sourceId: linkingFrom,
                    targetId,
                    screenX: e.clientX - (rect?.left ?? 0),
                    screenY: e.clientY - (rect?.top ?? 0),
                  });
                }
              }
            }
            setLinkingFrom(null);
            setMousePos(null);
          }}
        />
      )}

      {/* Main SVG */}
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        style={{ backgroundColor: "var(--color-bg-graph)", userSelect: "none" }}
        onMouseMove={handleSvgMouseMove}
        onMouseUp={handleSvgMouseUp}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            setLinkingFrom(null);
            setMousePos(null);
          }
        }}
        tabIndex={0}
      >
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
          {/* Time axis */}
          <TimeAxis
            startDate={dateRange.start}
            endDate={dateRange.end}
            width={graphWidth}
            height={layout?.height ? layout.height + 100 : dimensions.height}
            resolution={resolution}
          />

          {/* Dependency edges (rendered behind nodes) */}
          {layout?.edges.map((edge) => {
            // Offset edge points for the time-axis
            const offsetPoints = edge.points.map((p) => ({
              x: p.x,
              y: p.y + AXIS_OFFSET,
            }));
            return (
              <DependencyEdge
                key={edge.id}
                id={edge.id}
                points={offsetPoints}
                linkType={edge.linkType}
                highlighted={
                  hoveredTaskId === edge.source ||
                  hoveredTaskId === edge.target
                }
              />
            );
          })}

          {/* In-progress link line */}
          {linkingSourcePos && mousePos && (
            <line
              x1={linkingSourcePos.x}
              y1={linkingSourcePos.y}
              x2={mousePos.x}
              y2={mousePos.y}
              stroke="var(--color-accent)"
              strokeWidth={2}
              strokeDasharray="6,4"
              opacity={0.7}
            />
          )}

          {/* Task nodes — hovered node rendered last so it appears on top */}
          {[...visibleNodes].sort((a, b) => {
            if (a.id === hoveredTaskId) return 1;
            if (b.id === hoveredTaskId) return -1;
            return 0;
          }).map((node) => (
            <TaskNode
              key={node.id}
              id={node.id}
              title={node.task.title}
              dueDate={node.task.dueDate}
              statusName={node.task.status?.name ?? ""}
              statusColor={node.task.status?.color ?? "#6b7280"}
              priority={node.task.priority}
              tags={(node.task.tags ?? []).map((t) => t.tag)}
              assigneeName={node.task.assignee?.name?.trim() || node.task.assignee?.email || null}
              assigneeEmail={node.task.assignee?.email ?? null}
              assigneeImage={node.task.assignee?.image ?? null}
              dependencyState={node.task.dependencyState}
              x={node.x}
              y={node.y + AXIS_OFFSET}
              width={node.width}
              height={node.height}
              selected={focusedTaskId === node.id}
              highlighted={matchingTaskIds.size > 0 && matchingTaskIds.has(node.id)}
              alertLevel={getAlertLevel(
                node.task.dueDate,
                node.task.status?.category,
                node.task.alertAcknowledged ?? false,
                alertConfig
              )}
              isLinkTarget={!!linkingFrom && linkingFrom !== node.id}
              onClick={() => handleTaskClick(node.id)}
              onInfoClick={() => setDetailTaskId(node.id)}
              onMouseEnter={() => setHoveredTaskId(node.id)}
              onMouseLeave={() => setHoveredTaskId(null)}
              onPortDragStart={(side) => handlePortDragStart(node.id, side)}
              onPortDrop={(event) => handlePortDrop(node.id, event)}
            />
          ))}
        </g>
      </svg>

      {/* MiniMap */}
      {layout && layout.nodes.length > 0 && (
        <MiniMap
          nodes={layout.nodes}
          edges={layout.edges}
          graphWidth={layout.width || graphWidth}
          graphHeight={layout.height || dimensions.height}
          viewport={viewport}
          onNavigate={handleNavigate}
        />
      )}

      {/* Link type popup */}
      {pendingLink && (
        <LinkTypePopup
          x={pendingLink.screenX}
          y={pendingLink.screenY}
          onSelect={handleLinkTypeSelect}
          onCancel={() => setPendingLink(null)}
        />
      )}

      {detailTaskId && (
        <TaskDetail
          taskId={detailTaskId}
          statuses={statuses}
          onClose={() => setDetailTaskId(null)}
        />
      )}
    </div>
  );
}
