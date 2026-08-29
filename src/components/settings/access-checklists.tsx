"use client";

import { Field } from "@/components/ui/field";

export interface ProjectChecklistOption {
  id: string;
  key: string;
  name: string;
}

export interface GroupChecklistOption {
  id: string;
  name: string;
}

export interface AccessChecklistsProps {
  projects?: ProjectChecklistOption[];
  /** Local (non-OIDC-synced) groups available for membership */
  groups: GroupChecklistOption[];
  projectIds: string[];
  groupIds: string[];
  onToggleProject: (projectId: string) => void;
  onToggleGroup: (groupId: string) => void;
}

/**
 * The identical "Project Access" + "Groups" checkbox blocks used by both the
 * create-user and edit-user dialogs.
 */
export function AccessChecklists({
  projects,
  groups,
  projectIds,
  groupIds,
  onToggleProject,
  onToggleGroup,
}: AccessChecklistsProps) {
  return (
    <>
      <Field label="Project Access">
        {(ids) => (
        <div id={ids.id} aria-labelledby={ids.labelId} role="group">
        {projects && projects.length > 0 ? (
          <div
            className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
          >
            {projects.map((project) => (
              <label key={project.id} className="flex items-center gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={projectIds.includes(project.id)}
                  onChange={() => onToggleProject(project.id)}
                  className="accent-[var(--color-accent)]"
                />
                <span style={{ color: "var(--color-text)" }}>{project.key} - {project.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Create a project before assigning access.
          </p>
        )}
        </div>
        )}
      </Field>
      <Field label="Groups">
        {(ids) => (
        <div id={ids.id} aria-labelledby={ids.labelId} role="group">
        {groups.length > 0 ? (
          <div
            className="max-h-40 space-y-2 overflow-y-auto rounded-lg border p-3"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
          >
            {groups.map((group) => (
              <label key={group.id} className="flex items-center gap-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={groupIds.includes(group.id)}
                  onChange={() => onToggleGroup(group.id)}
                  className="accent-[var(--color-accent)]"
                />
                <span style={{ color: "var(--color-text)" }}>{group.name}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            Create a local group before assigning group membership.
          </p>
        )}
        </div>
        )}
      </Field>
    </>
  );
}
