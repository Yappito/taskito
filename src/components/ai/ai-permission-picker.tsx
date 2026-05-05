"use client";

import type { AiPermission } from "@/lib/ai-types";

interface AiPermissionPickerProps {
  permissions: readonly AiPermission[];
  value: AiPermission[];
  disabled?: boolean;
  onChange: (permissions: AiPermission[]) => void;
  compact?: boolean;
}

const LABELS: Record<AiPermission, string> = {
  read_current_task: "Read current task",
  read_selected_tasks: "Read selected tasks",
  search_project: "Search project",
  add_comment: "Add comments",
  link_tasks: "Link tasks",
  move_status: "Move status",
  assign_task: "Change assignee",
  edit_core_fields: "Edit title/body/dates",
  edit_tags: "Edit tags",
  edit_custom_fields: "Edit custom fields",
  bulk_update_selected: "Bulk update selected",
  create_task: "Create tasks",
  duplicate_task: "Duplicate tasks",
  archive_task: "Archive/unarchive",
};

export function AiPermissionPicker({ permissions, value, disabled = false, onChange, compact = false }: AiPermissionPickerProps) {
  const permissionSet = new Set(permissions);
  const allSelected = permissions.length > 0 && permissions.every((permission) => value.includes(permission));
  const selectedCount = permissions.filter((permission) => value.includes(permission)).length;

  function toggleAll() {
    onChange(
      allSelected
        ? value.filter((permission) => !permissionSet.has(permission))
        : [...new Set([...value, ...permissions])]
    );
  }

  if (compact) {
    return (
      <details className="relative" onClick={(event) => disabled && event.preventDefault()}>
        <summary
          className="flex h-9 cursor-pointer list-none items-center justify-between rounded-lg border px-3 text-sm"
          style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
        >
          <span>{selectedCount === 0 ? "No permissions" : `${selectedCount} permission${selectedCount === 1 ? "" : "s"} selected`}</span>
          <span style={{ color: "var(--color-text-muted)" }}>v</span>
        </summary>
        {!disabled && (
          <div
            className="absolute left-0 right-0 z-20 mt-2 max-h-80 overflow-y-auto rounded-2xl border p-3 shadow-xl"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text)" }}
          >
            <label
              className="mb-2 flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)", color: "var(--color-text-secondary)" }}
            >
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
              />
              <span>All permissions</span>
            </label>
            <div className="space-y-2">
              {permissions.map((permission) => {
                const checked = value.includes(permission);
                return (
                  <label
                    key={permission}
                    className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"
                    style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)", color: "var(--color-text-secondary)" }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        onChange(
                          checked
                            ? value.filter((item) => item !== permission)
                            : [...value, permission]
                        );
                      }}
                    />
                    <span>{LABELS[permission]}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </details>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={disabled || permissions.length === 0}
        onClick={toggleAll}
        className="rounded-xl border px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60"
        style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", color: "var(--color-text-secondary)" }}
      >
        {allSelected ? "Clear all permissions" : "Select all permissions"}
      </button>
      <div className="grid gap-2 sm:grid-cols-2">
        {permissions.map((permission) => {
          const checked = value.includes(permission);
          return (
            <label
              key={permission}
              className="flex items-center gap-2 rounded-xl border px-3 py-2 text-sm"
              style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)", color: "var(--color-text-secondary)" }}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => {
                  onChange(
                    checked
                      ? value.filter((item) => item !== permission)
                      : [...value, permission]
                  );
                }}
              />
              <span>{LABELS[permission]}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
