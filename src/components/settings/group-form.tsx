"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { toggleId } from "@/lib/id-list";

export type ProjectAccessRole = "viewer" | "member" | "manager" | "owner";

export interface GroupFormData {
  name: string;
  description: string;
  memberIds: string[];
  projectAccess: Array<{ projectId: string; role: ProjectAccessRole }>;
}

export const projectRoleOptions = ["viewer", "member", "manager", "owner"] as const;
export const emptyGroup: GroupFormData = { name: "", description: "", memberIds: [], projectAccess: [] };

/** Removes the project entry when role is "none", otherwise upserts the role */
export function setProjectAccessRole(
  access: Array<{ projectId: string; role: ProjectAccessRole }>,
  projectId: string,
  role: ProjectAccessRole | "none"
) {
  if (role === "none") {
    return access.filter((entry) => entry.projectId !== projectId);
  }
  const existing = access.find((entry) => entry.projectId === projectId);
  if (existing) {
    return access.map((entry) => entry.projectId === projectId ? { ...entry, role } : entry);
  }
  return [...access, { projectId, role }];
}

/** Current role for a project in the access list, "none" when absent */
export function projectRoleFor(access: Array<{ projectId: string; role: ProjectAccessRole }>, projectId: string): ProjectAccessRole | "none" {
  return access.find((entry) => entry.projectId === projectId)?.role ?? "none";
}

export interface GroupFormProps {
  value: GroupFormData;
  managedExternally?: boolean;
  onChange: (value: GroupFormData) => void;
  onSubmit: () => void;
  submitLabel: string;
  users: Array<{ id: string; name: string | null; email: string }>;
  projects: Array<{ id: string; key: string; name: string }>;
  onCancel: () => void;
  isPending: boolean;
  error?: string | null;
}

/** Create/edit form for a group: name, description, members and per-project roles */
export function GroupForm({
  value,
  managedExternally = false,
  onChange,
  onSubmit,
  submitLabel,
  users,
  projects,
  onCancel,
  isPending,
  error,
}: GroupFormProps) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <Field label="Name" required={!managedExternally}>
        {(ids) => (
          <Input id={ids.id}
            value={value.name}
            onChange={(event) => onChange({ ...value, name: event.target.value })}
            disabled={managedExternally}
            required
          />
        )}
      </Field>
      <Field label="Description">
        {(ids) => (
          <Input id={ids.id}
            value={value.description}
            onChange={(event) => onChange({ ...value, description: event.target.value })}
            placeholder="Optional description"
          />
        )}
      </Field>
      <Field label="Members">
        {(ids) => (
        <div id={ids.id} aria-labelledby={ids.labelId} role="group">
        {managedExternally ? (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Membership is synced from the OIDC provider.
          </p>
        ) : users.length > 0 ? (
          <div className="max-h-44 space-y-2 overflow-y-auto rounded-lg border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
            {users.map((user) => (
              <label key={user.id} className="flex items-center gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={value.memberIds.includes(user.id)}
                  onChange={() => onChange({ ...value, memberIds: toggleId(value.memberIds, user.id) })}
                  className="accent-[var(--color-accent)]"
                />
                <span style={{ color: "var(--color-text)" }}>{user.name ?? user.email}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>No users available.</p>
        )}
        </div>
        )}
      </Field>
      <Field label="Project Roles">
        {(ids) => (
        <div id={ids.id} aria-labelledby={ids.labelId} role="group">
        {projects.length > 0 ? (
          <div className="space-y-2 rounded-lg border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
            {projects.map((project) => (
              <div key={project.id} className="flex items-center justify-between gap-3 text-sm">
                <span style={{ color: "var(--color-text)" }}>{project.key} - {project.name}</span>
                <Select
                  value={projectRoleFor(value.projectAccess, project.id)}
                  onChange={(event) => onChange({
                    ...value,
                    projectAccess: setProjectAccessRole(value.projectAccess, project.id, event.target.value as ProjectAccessRole | "none"),
                  })}
                  aria-label={`Role for ${project.key} - ${project.name}`}
                  className="h-auto w-auto rounded-md px-2 py-1"
                >
                  <option value="none">No access</option>
                  {projectRoleOptions.map((role) => (
                    <option key={role} value={role}>{role}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>Create a project before assigning group access.</p>
        )}
        </div>
        )}
      </Field>
      {error && (
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
