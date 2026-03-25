"use client";

import { useEffect, useMemo, useState } from "react";
import type { TaskFilterPreset } from "@/lib/types";

type DateBoundary = "start" | "end";

export type TaskQuickDateFilter =
  | "due-this-week"
  | "closed-today"
  | "closed-this-week"
  | "closed-this-month"
  | "clear-dates";

function formatDateInput(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(base: Date, days: number) {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

function getStartOfWeek(base: Date) {
  const day = base.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = shiftDate(base, diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function getEndOfWeek(base: Date) {
  const sunday = shiftDate(getStartOfWeek(base), 6);
  sunday.setHours(0, 0, 0, 0);
  return sunday;
}

function getStartOfMonth(base: Date) {
  return new Date(base.getFullYear(), base.getMonth(), 1);
}

function getEndOfMonth(base: Date) {
  return new Date(base.getFullYear(), base.getMonth() + 1, 0);
}

function parseDateFilterValue(value: string, boundary: DateBoundary) {
  if (!value) {
    return undefined;
  }

  const timestamp = boundary === "start" ? `${value}T00:00:00.000` : `${value}T23:59:59.999`;
  const parsed = new Date(timestamp);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

export function useTaskViewFilters() {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedAssigneeIds, setSelectedAssigneeIds] = useState<string[]>([]);
  const [dueDateFrom, setDueDateFrom] = useState("");
  const [dueDateTo, setDueDateTo] = useState("");
  const [closedAtFrom, setClosedAtFrom] = useState("");
  const [closedAtTo, setClosedAtTo] = useState("");

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setDebouncedSearch(search);
    }, 250);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [search]);

  const queryFilters = useMemo(
    () => ({
      search: debouncedSearch.trim() || undefined,
      tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
      assigneeIds: selectedAssigneeIds.length > 0 ? selectedAssigneeIds : undefined,
      dueDateFrom: parseDateFilterValue(dueDateFrom, "start"),
      dueDateTo: parseDateFilterValue(dueDateTo, "end"),
      closedAtFrom: parseDateFilterValue(closedAtFrom, "start"),
      closedAtTo: parseDateFilterValue(closedAtTo, "end"),
    }),
    [debouncedSearch, selectedTagIds, selectedAssigneeIds, dueDateFrom, dueDateTo, closedAtFrom, closedAtTo]
  );

  function toggleTag(tagId: string) {
    setSelectedTagIds((prev) =>
      prev.includes(tagId) ? prev.filter((id) => id !== tagId) : [...prev, tagId]
    );
  }

  function toggleAssignee(assigneeId: string) {
    setSelectedAssigneeIds((prev) =>
      prev.includes(assigneeId) ? prev.filter((id) => id !== assigneeId) : [...prev, assigneeId]
    );
  }

  function clearFilters() {
    setSearch("");
    setSelectedTagIds([]);
    setSelectedAssigneeIds([]);
    setDueDateFrom("");
    setDueDateTo("");
    setClosedAtFrom("");
    setClosedAtTo("");
  }

  function applyPreset(preset: TaskFilterPreset) {
    setSearch(preset.search ?? "");
    setSelectedTagIds(preset.tagIds ?? []);
    setSelectedAssigneeIds(preset.assigneeIds ?? []);
    setDueDateFrom(preset.dueDateFrom ?? "");
    setDueDateTo(preset.dueDateTo ?? "");
    setClosedAtFrom(preset.closedAtFrom ?? "");
    setClosedAtTo(preset.closedAtTo ?? "");
  }

  function buildPreset(name: string): TaskFilterPreset {
    return {
      id: crypto.randomUUID(),
      name,
      search,
      tagIds: selectedTagIds,
      assigneeIds: selectedAssigneeIds,
      dueDateFrom,
      dueDateTo,
      closedAtFrom,
      closedAtTo,
    };
  }

  function applyQuickDateFilter(filter: TaskQuickDateFilter) {
    const today = new Date();
    const todayValue = formatDateInput(today);

    if (filter === "clear-dates") {
      setDueDateFrom("");
      setDueDateTo("");
      setClosedAtFrom("");
      setClosedAtTo("");
      return;
    }

    if (filter === "due-this-week") {
      setDueDateFrom(formatDateInput(getStartOfWeek(today)));
      setDueDateTo(formatDateInput(getEndOfWeek(today)));
      setClosedAtFrom("");
      setClosedAtTo("");
      return;
    }

    if (filter === "closed-today") {
      setClosedAtFrom(todayValue);
      setClosedAtTo(todayValue);
      setDueDateFrom("");
      setDueDateTo("");
      return;
    }

    if (filter === "closed-this-week") {
      setClosedAtFrom(formatDateInput(getStartOfWeek(today)));
      setClosedAtTo(formatDateInput(getEndOfWeek(today)));
      setDueDateFrom("");
      setDueDateTo("");
      return;
    }

    setClosedAtFrom(formatDateInput(getStartOfMonth(today)));
    setClosedAtTo(formatDateInput(getEndOfMonth(today)));
    setDueDateFrom("");
    setDueDateTo("");
  }

  return {
    search,
    setSearch,
    debouncedSearch,
    selectedTagIds,
    selectedAssigneeIds,
    dueDateFrom,
    dueDateTo,
    closedAtFrom,
    closedAtTo,
    setDueDateFrom,
    setDueDateTo,
    setClosedAtFrom,
    setClosedAtTo,
    queryFilters,
    toggleTag,
    toggleAssignee,
    clearFilters,
    applyPreset,
    buildPreset,
    applyQuickDateFilter,
  };
}