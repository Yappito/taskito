"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface TaskOption {
  id: string;
  taskNumber?: number;
  title: string;
  project?: { key: string };
}

interface TaskSearchInputProps {
  tasks: TaskOption[];
  value: string;
  onChange: (taskId: string) => void;
  placeholder?: string;
}

/** Searchable combobox for selecting tasks — replaces plain dropdown */
export function TaskSearchInput({
  tasks,
  value,
  onChange,
  placeholder = "Search tasks...",
}: TaskSearchInputProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const filtered = tasks.filter((t) => {
    const q = search.toLowerCase();
    const key =
      t.project?.key && t.taskNumber
        ? `${t.project.key}-${t.taskNumber}`.toLowerCase()
        : "";
    return (
      t.title.toLowerCase().includes(q) ||
      key.includes(q) ||
      t.id.toLowerCase().includes(q)
    );
  });

  const selectedTask = tasks.find((t) => t.id === value);

  const handleSelect = useCallback(
    (taskId: string) => {
      onChange(taskId);
      setOpen(false);
      setSearch("");
    },
    [onChange]
  );

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
    }
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen(!open);
          setTimeout(() => inputRef.current?.focus(), 50);
        }}
        className="flex h-9 w-full items-center rounded-md border px-3 py-1 text-sm text-left"
        style={{
          backgroundColor: "var(--color-surface)",
          borderColor: "var(--color-border)",
          color: selectedTask ? "var(--color-text)" : "var(--color-text-muted)",
        }}
      >
        {selectedTask ? (
          <span className="truncate">
            {selectedTask.project?.key && selectedTask.taskNumber && (
              <span
                className="mr-1.5 font-semibold"
                style={{ color: "var(--color-text-muted)" }}
              >
                {selectedTask.project.key}-{selectedTask.taskNumber}
              </span>
            )}
            {selectedTask.title}
          </span>
        ) : (
          placeholder
        )}
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 w-full rounded-lg shadow-lg"
          style={{
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          <div
            className="p-2"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type to filter..."
              className="w-full rounded border-0 bg-transparent px-2 py-1.5 text-sm focus:outline-none"
              style={{ color: "var(--color-text)" }}
            />
          </div>
          <div className="max-h-48 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <div
                className="px-3 py-2 text-xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                No matching tasks
              </div>
            ) : (
              filtered.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => handleSelect(task.id)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
                  style={{ color: "var(--color-text)" }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.backgroundColor =
                      "var(--color-surface-hover)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.backgroundColor = "transparent")
                  }
                >
                  {task.project?.key && task.taskNumber && (
                    <span
                      className="shrink-0 text-[10px] font-semibold"
                      style={{ color: "var(--color-text-muted)" }}
                    >
                      {task.project.key}-{task.taskNumber}
                    </span>
                  )}
                  <span className="truncate">{task.title}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
