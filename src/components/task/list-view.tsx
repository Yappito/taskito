"use client";

import { useEffect, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { getAlertConfig, getAlertLevel } from "@/lib/alert-utils";

import { TaskDetail } from "./task-detail";
import { StatusBadge } from "./status-badge";
import { TaskViewFilters } from "./task-view-filters";
import type { TaskFilterTagOption } from "@/lib/types";

interface ListViewProps {
  projectId: string;
  statuses: Array<{ id: string; name: string; color: string }>;
  tags: TaskFilterTagOption[];
  projectSettings?: Record<string, unknown> | null;
}

/** List view — sortable table of tasks */
export function ListView({ projectId, statuses, tags, projectSettings }: ListViewProps) {
  const alertConfig = getAlertConfig(projectSettings);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [sortField, setSortField] = useState<"dueDate" | "title" | "priority">("dueDate");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [search]);

  const taskListInput = useMemo(
    () => ({
      projectId,
      limit: 100,
      search: debouncedSearch.trim() || undefined,
      tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
    }),
    [projectId, debouncedSearch, selectedTagIds]
  );

  const { data, isLoading } = trpc.task.list.useQuery(taskListInput, {
    placeholderData: (previousData) => previousData,
  });

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  }

  function clearFilters() {
    setSearch("");
    setSelectedTagIds([]);
  }

  if (isLoading && !data) {
    return (
      <div className="animate-pulse space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-12 rounded"
            style={{ backgroundColor: "var(--color-bg-muted)" }}
          />
        ))}
      </div>
    );
  }

  const tasks = data?.items ?? [];

  const sorted = [...tasks].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortField === "dueDate") {
      return (new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()) * dir;
    }
    if (sortField === "title") {
      return a.title.localeCompare(b.title) * dir;
    }
    const priorityOrder = { urgent: 4, high: 3, medium: 2, low: 1, none: 0 };
    return ((priorityOrder[a.priority] ?? 0) - (priorityOrder[b.priority] ?? 0)) * dir;
  });

  function handleSort(field: typeof sortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  const sortIcon = (field: string) =>
    sortField === field ? (sortDir === "asc" ? " ↑" : " ↓") : "";

  return (
    <div className="flex flex-col">
      <TaskViewFilters
        search={search}
        selectedTagIds={selectedTagIds}
        tags={tags}
        onSearchChange={setSearch}
        onToggleTag={toggleTag}
        onClear={clearFilters}
        className="mx-4 mt-4"
      />

      <div className="flex-1 overflow-x-auto p-4 pt-3">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="border-b text-left text-xs font-medium uppercase"
              style={{
                backgroundColor: "var(--color-bg-muted)",
                borderColor: "var(--color-border)",
                color: "var(--color-text-muted)",
              }}
            >
              <th
                className="cursor-pointer px-4 py-3"
                onClick={() => handleSort("title")}
              >
                Title{sortIcon("title")}
              </th>
              <th className="px-4 py-3">Status</th>
              <th
                className="cursor-pointer px-4 py-3"
                onClick={() => handleSort("priority")}
              >
                Priority{sortIcon("priority")}
              </th>
              <th
                className="cursor-pointer px-4 py-3"
                onClick={() => handleSort("dueDate")}
              >
                Due Date{sortIcon("dueDate")}
              </th>
              <th className="px-4 py-3">Tags</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((task) => {
              const alertLevel = getAlertLevel(
                task.dueDate,
                (task.status as { category?: string }).category,
                (task as { alertAcknowledged?: boolean }).alertAcknowledged ?? false,
                alertConfig
              );
              return (
              <tr
                key={task.id}
                onClick={() => setSelectedTaskId(task.id)}
                className={cn(
                  "cursor-pointer border-b transition-colors",
                  alertLevel === "critical" && "pulse-critical",
                  alertLevel === "warning" && "pulse-warning"
                )}
                style={{
                  borderColor: "var(--color-border)",
                  backgroundColor:
                    selectedTaskId === task.id
                      ? "var(--color-accent-muted)"
                      : undefined,
                }}
                onMouseEnter={(e) => {
                  if (selectedTaskId !== task.id)
                    e.currentTarget.style.backgroundColor = "var(--color-surface-hover)";
                }}
                onMouseLeave={(e) => {
                  if (selectedTaskId !== task.id)
                    e.currentTarget.style.backgroundColor = "";
                }}
              >
                <td className="px-4 py-3 font-medium" style={{ color: "var(--color-text)" }}>
                  {(task as { taskNumber?: number }).taskNumber && (task as { project?: { key: string } }).project?.key && (
                    <span
                      className="mr-2 text-[10px] font-semibold"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {(task as { project?: { key: string } }).project!.key}-{(task as { taskNumber?: number }).taskNumber}
                    </span>
                  )}
                  {task.title}
                </td>
                <td className="px-4 py-3">
                  <StatusBadge name={task.status.name} color={task.status.color} />
                </td>
                <td className="px-4 py-3 capitalize" style={{ color: "var(--color-text-secondary)" }}>
                  {task.priority}
                </td>
                <td className="px-4 py-3" style={{ color: "var(--color-text-secondary)" }}>
                  {new Date(task.dueDate).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <div className="flex gap-1">
                    {task.tags.slice(0, 2).map(({ tag }: { tag: { id: string; name: string; color: string } }) => (
                      <span
                        key={tag.id}
                        className="rounded px-1.5 py-0.5 text-xs"
                        style={{
                          backgroundColor: `${tag.color}20`,
                          color: tag.color,
                        }}
                      >
                        {tag.name}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        {tasks.length === 0 && (
          <p
            className="p-8 text-center"
            style={{ color: "var(--color-text-muted)" }}
          >
            No tasks yet. Create one!
          </p>
        )}
      </div>

      {selectedTaskId && (
        <TaskDetail
          taskId={selectedTaskId}
          statuses={statuses}
          onClose={() => setSelectedTaskId(null)}
        />
      )}
    </div>
  );
}
