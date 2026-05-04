"use client";

import { useState, use } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Tag management page: CRUD, merge, color */
export default function TagSettingsPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = use(params);
  const { data: project } = trpc.project.bySlug.useQuery({ slug: projectSlug });

  if (!project) {
    return <div className="p-8" style={{ color: "var(--color-text-muted)" }}>Loading...</div>;
  }

  return <TagSettingsContent projectId={project.id} />;
}

function TagSettingsContent({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const { data: tags = [] } = trpc.tag.list.useQuery({ projectId });

  const [newTag, setNewTag] = useState({ name: "", color: "#6b7280" });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");
  const [mergeMode, setMergeMode] = useState<string | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");

  const createMutation = trpc.tag.create.useMutation({
    onSuccess: () => {
      utils.tag.list.invalidate();
      setNewTag({ name: "", color: "#6b7280" });
    },
  });

  const updateMutation = trpc.tag.update.useMutation({
    onSuccess: () => {
      utils.tag.list.invalidate();
      setEditingId(null);
    },
  });

  const deleteMutation = trpc.tag.delete.useMutation({
    onSuccess: () => utils.tag.list.invalidate(),
  });

  const mergeMutation = trpc.tag.merge.useMutation({
    onSuccess: () => {
      utils.tag.list.invalidate();
      setMergeMode(null);
      setMergeTargetId("");
    },
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 lg:px-6">
      <div className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", background: "linear-gradient(135deg, color-mix(in srgb, var(--color-info) 10%, var(--color-surface)) 0%, var(--color-surface) 64%)", boxShadow: "var(--shadow-sm)" }}>
        <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>Project taxonomy</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>Tag Management</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Keep labels clean, merge duplicates, and use color to make work scannable.
        </p>
      </div>

      {/* Create new tag */}
      <div className="flex flex-col gap-3 rounded-3xl border p-5 md:flex-row md:items-end" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
        <div className="flex-1 space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Name</label>
          <Input
            value={newTag.name}
            onChange={(e) => setNewTag({ ...newTag, name: e.target.value })}
            placeholder="New tag name"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Color</label>
          <input
            type="color"
            value={newTag.color}
            onChange={(e) => setNewTag({ ...newTag, color: e.target.value })}
            className="h-9 w-12 cursor-pointer rounded-lg border"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
          />
        </div>
        <Button
          onClick={() =>
            createMutation.mutate({ projectId, name: newTag.name, color: newTag.color })
          }
          disabled={!newTag.name.trim()}
        >
          Create Tag
        </Button>
      </div>

      {/* Tag list */}
      <div className="space-y-2">
        {tags.map((tag) => (
          <div
            key={tag.id}
            className="flex items-center gap-3 rounded-2xl border p-4"
            style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}
          >
            <div
              className="h-4 w-4 rounded-full"
              style={{ backgroundColor: tag.color }}
            />

            {editingId === tag.id ? (
              <div className="flex flex-1 items-center gap-2">
                <Input
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="w-40"
                />
                <input
                  type="color"
                  value={editColor}
                  onChange={(e) => setEditColor(e.target.value)}
                  className="h-9 w-10 cursor-pointer rounded-lg border"
                  style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
                />
                <Button
                  size="sm"
                  onClick={() =>
                    updateMutation.mutate({
                      id: tag.id,
                      name: editName,
                      color: editColor,
                    })
                  }
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditingId(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : mergeMode === tag.id ? (
              <div className="flex flex-1 items-center gap-2">
                <span className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
                  Merge &quot;{tag.name}&quot; into:
                </span>
                <select
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  className="h-9 rounded-lg border px-2 text-sm"
                  style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}
                >
                  <option value="">Select target tag...</option>
                  {tags
                    .filter((t) => t.id !== tag.id)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                </select>
                <Button
                  size="sm"
                  onClick={() =>
                    mergeMutation.mutate({
                      sourceTagId: tag.id,
                      targetTagId: mergeTargetId,
                    })
                  }
                  disabled={!mergeTargetId}
                >
                  Merge
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMergeMode(null)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <span className="flex-1 font-medium" style={{ color: "var(--color-text)" }}>{tag.name}</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      setEditingId(tag.id);
                      setEditName(tag.name);
                      setEditColor(tag.color);
                    }}
                    className="rounded p-1 text-xs"
                    style={{ color: "var(--color-accent)" }}
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => setMergeMode(tag.id)}
                    className="rounded p-1 text-xs"
                    style={{ color: "var(--color-warning)" }}
                  >
                    Merge
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete tag "${tag.name}"?`)) {
                        deleteMutation.mutate({ id: tag.id });
                      }
                    }}
                    className="rounded p-1 text-xs"
                    style={{ color: "var(--color-danger)" }}
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {tags.length === 0 && (
          <p className="py-8 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>No tags yet</p>
        )}
      </div>
    </div>
  );
}
