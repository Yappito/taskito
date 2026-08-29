"use client";

import { useState, useRef, useEffect, useCallback, useId, useMemo } from "react";

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

/**
 * Searchable combobox for selecting tasks — replaces plain dropdown.
 *
 * ARIA combobox pattern: the trigger button opens a popup whose filter input
 * has role="combobox" (aria-expanded/aria-controls) and owns a listbox of
 * options. ArrowUp/ArrowDown move the active option, Enter selects it, Escape
 * closes and returns focus to the trigger. Option rows keep their buttons as
 * click targets; each is wrapped in role="option" and referenced via
 * aria-activedescendant.
 */
export function TaskSearchInput({
  tasks,
  value,
  onChange,
  placeholder = "Search tasks...",
}: TaskSearchInputProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const idPrefix = useId().replace(/[^a-zA-Z0-9-]/g, "");
  const listboxId = `${idPrefix}-listbox`;
  const activeOptionId = useMemo(
    () => (open && activeIndex >= 0 ? `${idPrefix}-option-${activeIndex}` : undefined),
    [open, activeIndex, idPrefix]
  );

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
      setActiveIndex(0);
      triggerRef.current?.focus();
    },
    [onChange]
  );

  const closeListbox = useCallback((returnFocus: boolean) => {
    setOpen(false);
    setActiveIndex(0);
    if (returnFocus) {
      triggerRef.current?.focus();
    }
  }, []);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
        setSearch("");
        setActiveIndex(0);
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
      if (e.key === "Escape") closeListbox(true);
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
    }
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, closeListbox]);

  function handleComboboxKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length === 0) return;
      const direction = e.key === "ArrowDown" ? 1 : -1;
      const next = (activeIndex + direction + filtered.length) % filtered.length;
      setActiveIndex(next);
      listboxRef.current
        ?.querySelector(`[data-option-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }

    if (e.key === "Enter") {
      e.preventDefault();
      const task = filtered[activeIndex] ?? filtered[0];
      if (task) {
        handleSelect(task.id);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      closeListbox(true);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        onClick={() => {
          setOpen(!open);
          setActiveIndex(0);
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
              role="combobox"
              aria-expanded
              aria-controls={listboxId}
              aria-autocomplete="list"
              aria-activedescendant={activeOptionId}
              aria-haspopup="listbox"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={handleComboboxKeyDown}
              placeholder="Type to filter..."
              className="w-full rounded border-0 bg-transparent px-2 py-1.5 text-sm"
              style={{ color: "var(--color-text)" }}
            />
          </div>
          <div
            ref={listboxRef}
            role="listbox"
            id={listboxId}
            aria-label="Task search results"
            className="max-h-48 overflow-y-auto py-1"
          >
            {filtered.length === 0 ? (
              <div
                className="px-3 py-2 text-xs"
                style={{ color: "var(--color-text-muted)" }}
              >
                No matching tasks
              </div>
            ) : (
              filtered.map((task, index) => (
                <div
                  key={task.id}
                  role="option"
                  id={`${idPrefix}-option-${index}`}
                  data-option-index={index}
                  aria-selected={index === activeIndex}
                  style={
                    index === activeIndex
                      ? { backgroundColor: "var(--color-surface-hover)" }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => handleSelect(task.id)}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors"
                    style={{ color: "var(--color-text)" }}
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
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}