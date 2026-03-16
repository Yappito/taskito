"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogControlled as Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Settings page — project and user management */
export default function SettingsPage() {
  const [tab, setTab] = useState<"projects" | "users">("projects");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1
        className="text-2xl font-bold mb-6"
        style={{ color: "var(--color-text)" }}
      >
        Settings
      </h1>

      {/* Tabs */}
      <div
        className="flex gap-1 rounded-lg p-1 mb-6"
        style={{ backgroundColor: "var(--color-bg-muted)" }}
      >
        {(["projects", "users"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors"
            style={
              tab === t
                ? {
                    backgroundColor: "var(--color-surface)",
                    color: "var(--color-text)",
                    boxShadow: "var(--shadow-sm)",
                  }
                : { color: "var(--color-text-secondary)" }
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "projects" ? <ProjectManagement /> : <UserManagement />}
    </div>
  );
}

// ------- Project Management -------

interface ProjectFormData {
  name: string;
  slug: string;
  key: string;
  description: string;
}

const emptyProject: ProjectFormData = { name: "", slug: "", key: "", description: "" };

function ProjectManagement() {
  const utils = trpc.useUtils();
  const { data: projects, isLoading } = trpc.project.list.useQuery();
  const createMutation = trpc.project.create.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
      setCreateOpen(false);
      setForm(emptyProject);
    },
  });
  const updateMutation = trpc.project.update.useMutation({
    onSuccess: () => {
      utils.project.list.invalidate();
      setEditOpen(false);
      setEditingProject(null);
    },
  });
  const deleteMutation = trpc.project.delete.useMutation({
    onSuccess: () => utils.project.list.invalidate(),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<ProjectFormData>(emptyProject);
  const [editingProject, setEditingProject] = useState<{ id: string; name: string; description: string | null } | null>(null);
  const [editForm, setEditForm] = useState({ name: "", description: "" });

  /** Auto-generate slug and key from project name */
  function handleNameChange(name: string) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .slice(0, 50);
    const key = name
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 5);
    setForm((f) => ({ ...f, name, slug, key }));
  }

  function openEdit(project: { id: string; name: string; description: string | null }) {
    setEditingProject(project);
    setEditForm({ name: project.name, description: project.description ?? "" });
    setEditOpen(true);
  }

  if (isLoading) {
    return (
      <div className="animate-pulse py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
        Loading projects...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          Projects
        </h2>
        <Button onClick={() => setCreateOpen(true)}>New Project</Button>
      </div>

      {/* Project list */}
      <div className="space-y-2">
        {projects?.map((project) => (
          <div
            key={project.id}
            className="flex items-center justify-between rounded-lg px-4 py-3"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-1.5 py-0.5 text-xs font-mono font-medium"
                  style={{
                    backgroundColor: "var(--color-accent-muted)",
                    color: "var(--color-accent)",
                  }}
                >
                  {project.key}
                </span>
                <span className="font-medium" style={{ color: "var(--color-text)" }}>
                  {project.name}
                </span>
                <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                  /{project.slug}
                </span>
              </div>
              {project.description && (
                <p className="mt-1 text-sm truncate" style={{ color: "var(--color-text-secondary)" }}>
                  {project.description}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 ml-4">
              <Button variant="outline" size="sm" onClick={() => openEdit(project)}>
                Edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (confirm("Delete this project and all its tasks? This cannot be undone.")) {
                    deleteMutation.mutate({ id: project.id });
                  }
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        {projects?.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
            No projects yet. Create one to get started.
          </div>
        )}
      </div>

      {/* Create Project Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate({
                name: form.name,
                slug: form.slug,
                key: form.key,
                description: form.description || undefined,
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Name
              </label>
              <Input
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="My Project"
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                  Slug
                </label>
                <Input
                  value={form.slug}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  placeholder="my-project"
                  pattern="^[a-z0-9-]+$"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                  Key
                </label>
                <Input
                  value={form.key}
                  onChange={(e) => setForm((f) => ({ ...f, key: e.target.value.toUpperCase() }))}
                  placeholder="PROJ"
                  pattern="^[A-Z0-9]+$"
                  maxLength={10}
                  required
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Description
              </label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description"
              />
            </div>
            {createMutation.error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {createMutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Project Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Project</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editingProject) return;
              updateMutation.mutate({
                id: editingProject.id,
                name: editForm.name,
                description: editForm.description || undefined,
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Name
              </label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Description
              </label>
              <Input
                value={editForm.description}
                onChange={(e) => setEditForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description"
              />
            </div>
            {updateMutation.error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {updateMutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ------- User Management -------

interface UserFormData {
  name: string;
  email: string;
  password: string;
  role: "admin" | "member";
  projectIds: string[];
}

const emptyUser: UserFormData = { name: "", email: "", password: "", role: "member", projectIds: [] };

function UserManagement() {
  const utils = trpc.useUtils();
  const { data: users, isLoading } = trpc.user.list.useQuery();
  const { data: projects } = trpc.project.list.useQuery();
  const createMutation = trpc.user.create.useMutation({
    onSuccess: () => {
      utils.user.list.invalidate();
      setCreateOpen(false);
      setForm(emptyUser);
    },
  });
  const updateMutation = trpc.user.update.useMutation({
    onSuccess: () => {
      utils.user.list.invalidate();
      setEditOpen(false);
      setEditingUser(null);
    },
  });
  const deleteMutation = trpc.user.delete.useMutation({
    onSuccess: () => utils.user.list.invalidate(),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState<UserFormData>(emptyUser);
  const [editingUser, setEditingUser] = useState<{
    id: string;
    name: string | null;
    email: string | null;
    role: string;
    projectMemberships: Array<{
      projectId: string;
      role: string;
      project: { id: string; name: string; key: string; slug: string };
    }>;
  } | null>(null);
  const [editForm, setEditForm] = useState({ name: "", email: "", role: "member" as "admin" | "member", password: "", projectIds: [] as string[] });

  function toggleSelectedProject(currentIds: string[], projectId: string) {
    return currentIds.includes(projectId)
      ? currentIds.filter((id) => id !== projectId)
      : [...currentIds, projectId];
  }

  function openEdit(user: {
    id: string;
    name: string | null;
    email: string | null;
    role: string;
    projectMemberships: Array<{
      projectId: string;
      role: string;
      project: { id: string; name: string; key: string; slug: string };
    }>;
  }) {
    setEditingUser(user);
    setEditForm({
      name: user.name ?? "",
      email: user.email ?? "",
      role: user.role as "admin" | "member",
      password: "",
      projectIds: user.projectMemberships.map((membership) => membership.projectId),
    });
    setEditOpen(true);
  }

  if (isLoading) {
    return (
      <div className="animate-pulse py-12 text-center" style={{ color: "var(--color-text-muted)" }}>
        Loading users...
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          Users
        </h2>
        <Button onClick={() => setCreateOpen(true)}>New User</Button>
      </div>

      {/* User list */}
      <div className="space-y-2">
        {users?.map((user) => (
          <div
            key={user.id}
            className="flex items-center justify-between rounded-lg px-4 py-3"
            style={{
              backgroundColor: "var(--color-surface)",
              border: "1px solid var(--color-border)",
            }}
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-medium"
                style={{
                  backgroundColor: "var(--color-accent-muted)",
                  color: "var(--color-accent)",
                }}
              >
                {(user.name ?? user.email ?? "?").charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium" style={{ color: "var(--color-text)" }}>
                    {user.name ?? "—"}
                  </span>
                  <span
                    className="rounded px-1.5 py-0.5 text-xs capitalize"
                    style={{
                      backgroundColor: user.role === "admin" ? "var(--color-warning-muted, var(--color-accent-muted))" : "var(--color-bg-muted)",
                      color: user.role === "admin" ? "var(--color-warning, var(--color-accent))" : "var(--color-text-muted)",
                    }}
                  >
                    {user.role}
                  </span>
                </div>
                <p className="text-sm truncate" style={{ color: "var(--color-text-secondary)" }}>
                  {user.email}
                </p>
                <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  {user.projectMemberships.length > 0
                    ? user.projectMemberships.map((membership) => `${membership.project.key} ${membership.project.name}`).join(" • ")
                    : "No project access"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 ml-4">
              <Button variant="outline" size="sm" onClick={() => openEdit(user)}>
                Edit
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (confirm("Delete this user? This cannot be undone.")) {
                    deleteMutation.mutate({ id: user.id });
                  }
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
        {users?.length === 0 && (
          <div className="py-12 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
            No users found.
          </div>
        )}
      </div>

      {/* Create User Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create User</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              createMutation.mutate(form);
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Name
              </label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="John Doe"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Email
              </label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="john@example.com"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Password
              </label>
              <Input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Min 6 characters"
                minLength={6}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Role
              </label>
              <div className="flex gap-4">
                {(["member", "admin"] as const).map((r) => (
                  <label key={r} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="role"
                      value={r}
                      checked={form.role === r}
                      onChange={() => setForm((f) => ({ ...f, role: r }))}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="text-sm capitalize" style={{ color: "var(--color-text)" }}>
                      {r}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
                Project Access
              </label>
              {projects && projects.length > 0 ? (
                <div
                  className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3"
                  style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
                >
                  {projects.map((project) => (
                    <label key={project.id} className="flex items-center gap-3 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.projectIds.includes(project.id)}
                        onChange={() =>
                          setForm((current) => ({
                            ...current,
                            projectIds: toggleSelectedProject(current.projectIds, project.id),
                          }))
                        }
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
            {createMutation.error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {createMutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? "Creating..." : "Create"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit User Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!editingUser) return;
              updateMutation.mutate({
                id: editingUser.id,
                name: editForm.name,
                email: editForm.email,
                role: editForm.role,
                password: editForm.password || undefined,
                projectIds: editForm.projectIds,
              });
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Name
              </label>
              <Input
                value={editForm.name}
                onChange={(e) => setEditForm((f) => ({ ...f, name: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Email
              </label>
              <Input
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm((f) => ({ ...f, email: e.target.value }))}
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                New Password
              </label>
              <Input
                type="password"
                value={editForm.password}
                onChange={(e) => setEditForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Leave blank to keep current"
                minLength={6}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" style={{ color: "var(--color-text-secondary)" }}>
                Role
              </label>
              <div className="flex gap-4">
                {(["member", "admin"] as const).map((r) => (
                  <label key={r} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="edit-role"
                      value={r}
                      checked={editForm.role === r}
                      onChange={() => setEditForm((f) => ({ ...f, role: r }))}
                      className="accent-[var(--color-accent)]"
                    />
                    <span className="text-sm capitalize" style={{ color: "var(--color-text)" }}>
                      {r}
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: "var(--color-text-secondary)" }}>
                Project Access
              </label>
              {projects && projects.length > 0 ? (
                <div
                  className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-3"
                  style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}
                >
                  {projects.map((project) => (
                    <label key={project.id} className="flex items-center gap-3 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editForm.projectIds.includes(project.id)}
                        onChange={() =>
                          setEditForm((current) => ({
                            ...current,
                            projectIds: toggleSelectedProject(current.projectIds, project.id),
                          }))
                        }
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
            {updateMutation.error && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {updateMutation.error.message}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
