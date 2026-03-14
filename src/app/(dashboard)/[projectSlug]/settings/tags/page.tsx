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
    return <div className="p-8 text-gray-500">Loading...</div>;
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
    <div className="mx-auto max-w-2xl p-6 space-y-6">
      <h1 className="text-2xl font-bold">Tag Management</h1>

      {/* Create new tag */}
      <div className="flex items-end gap-3 rounded-lg border-2 border-dashed p-4">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-gray-500">Name</label>
          <Input
            value={newTag.name}
            onChange={(e) => setNewTag({ ...newTag, name: e.target.value })}
            placeholder="New tag name"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-gray-500">Color</label>
          <input
            type="color"
            value={newTag.color}
            onChange={(e) => setNewTag({ ...newTag, color: e.target.value })}
            className="h-9 w-12 cursor-pointer rounded border"
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
            className="flex items-center gap-3 rounded-lg border p-3"
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
                  className="h-9 w-10 cursor-pointer rounded border"
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
                <span className="text-sm">
                  Merge &quot;{tag.name}&quot; into:
                </span>
                <select
                  value={mergeTargetId}
                  onChange={(e) => setMergeTargetId(e.target.value)}
                  className="h-9 rounded border px-2 text-sm"
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
                <span className="flex-1 font-medium">{tag.name}</span>
                <div className="flex gap-1">
                  <button
                    onClick={() => {
                      setEditingId(tag.id);
                      setEditName(tag.name);
                      setEditColor(tag.color);
                    }}
                    className="rounded p-1 text-xs text-gray-400 hover:text-blue-600"
                  >
                    Rename
                  </button>
                  <button
                    onClick={() => setMergeMode(tag.id)}
                    className="rounded p-1 text-xs text-gray-400 hover:text-amber-600"
                  >
                    Merge
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete tag "${tag.name}"?`)) {
                        deleteMutation.mutate({ id: tag.id });
                      }
                    }}
                    className="rounded p-1 text-xs text-gray-400 hover:text-red-600"
                  >
                    Delete
                  </button>
                </div>
              </>
            )}
          </div>
        ))}
        {tags.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-8">No tags yet</p>
        )}
      </div>
    </div>
  );
}
