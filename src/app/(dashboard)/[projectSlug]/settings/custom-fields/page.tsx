"use client";

import { use, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { trpc } from "@/lib/trpc-client";

const FIELD_TYPES = ["text", "number", "date", "select"] as const;

export default function CustomFieldSettingsPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = use(params);
  const { data: project } = trpc.project.bySlug.useQuery({ slug: projectSlug });

  if (!project) {
    return <div className="p-8" style={{ color: "var(--color-text-muted)" }}>Loading...</div>;
  }

  return <CustomFieldSettingsContent projectId={project.id} />;
}

function CustomFieldSettingsContent({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const { data: fields = [] } = trpc.customField.list.useQuery({ projectId });

  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof FIELD_TYPES)[number]>("text");
  const [required, setRequired] = useState(false);
  const [choices, setChoices] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editType, setEditType] = useState<(typeof FIELD_TYPES)[number]>("text");
  const [editRequired, setEditRequired] = useState(false);
  const [editChoices, setEditChoices] = useState("");

  const upsertMutation = trpc.customField.upsert.useMutation({
    onSuccess: () => {
      utils.customField.list.invalidate({ projectId });
      setName("");
      setType("text");
      setRequired(false);
      setChoices("");
      setEditingId(null);
    },
  });

  const deleteMutation = trpc.customField.delete.useMutation({
    onSuccess: () => {
      utils.customField.list.invalidate({ projectId });
    },
  });

  const reorderMutation = trpc.customField.reorder.useMutation({
    onSuccess: () => {
      utils.customField.list.invalidate({ projectId });
    },
  });

  function parseChoices(value: string) {
    return value
      .split(",")
      .map((choice) => choice.trim())
      .filter(Boolean);
  }

  function moveField(index: number, direction: -1 | 1) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= fields.length) {
      return;
    }

    const orderedIds = fields.map((field) => field.id);
    [orderedIds[index], orderedIds[newIndex]] = [orderedIds[newIndex], orderedIds[index]];
    reorderMutation.mutate({ projectId, fieldIds: orderedIds });
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-8 lg:px-6">
      <div className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", background: "linear-gradient(135deg, color-mix(in srgb, var(--color-accent) 9%, var(--color-surface)) 0%, var(--color-surface) 62%)", boxShadow: "var(--shadow-sm)" }}>
        <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>Project schema</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>Custom Fields</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Shape project-specific task metadata without changing the database schema.
        </p>
      </div>

      <div className="rounded-3xl border p-5" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Field name</label>
            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer, Estimate, Release date..." />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Type</label>
            <select value={type} onChange={(event) => setType(event.target.value as (typeof FIELD_TYPES)[number])} className="h-9 w-full rounded-lg border px-2 text-sm" style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}>
              {FIELD_TYPES.map((fieldType) => (
                <option key={fieldType} value={fieldType}>
                  {fieldType}
                </option>
              ))}
            </select>
          </div>
        </div>

        {type === "select" && (
          <div className="mt-3 space-y-1">
            <label className="text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>Options</label>
            <Input value={choices} onChange={(event) => setChoices(event.target.value)} placeholder="Low, Medium, High" />
          </div>
        )}

        <label className="mt-3 flex items-center gap-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          <input type="checkbox" checked={required} onChange={(event) => setRequired(event.target.checked)} />
          Required field
        </label>

        <div className="mt-4">
          <Button
            disabled={!name.trim() || upsertMutation.isPending}
            onClick={() =>
              upsertMutation.mutate({
                projectId,
                name: name.trim(),
                type,
                required,
                options: type === "select" ? { choices: parseChoices(choices) } : undefined,
              })
            }
          >
            Add field
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        {fields.map((field, index) => {
          const fieldChoices = Array.isArray((field.options as { choices?: string[] } | null)?.choices)
            ? ((field.options as { choices?: string[] }).choices ?? [])
            : [];

          return (
            <div key={field.id} className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}>
              {editingId === field.id ? (
                <div className="space-y-3">
                  <Input value={editName} onChange={(event) => setEditName(event.target.value)} />
                  <select value={editType} onChange={(event) => setEditType(event.target.value as (typeof FIELD_TYPES)[number])} className="h-9 w-full rounded-lg border px-2 text-sm" style={{ backgroundColor: "var(--color-surface)", borderColor: "var(--color-border)", color: "var(--color-text)" }}>
                    {FIELD_TYPES.map((fieldType) => (
                      <option key={fieldType} value={fieldType}>
                        {fieldType}
                      </option>
                    ))}
                  </select>
                  {editType === "select" && (
                    <Input value={editChoices} onChange={(event) => setEditChoices(event.target.value)} placeholder="Low, Medium, High" />
                  )}
                  <label className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text-secondary)" }}>
                    <input type="checkbox" checked={editRequired} onChange={(event) => setEditRequired(event.target.checked)} />
                    Required field
                  </label>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() =>
                        upsertMutation.mutate({
                          id: field.id,
                          projectId,
                          name: editName.trim(),
                          type: editType,
                          required: editRequired,
                          options: editType === "select" ? { choices: parseChoices(editChoices) } : undefined,
                        })
                      }
                    >
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3">
                  <div className="flex-1">
                    <div className="font-medium" style={{ color: "var(--color-text)" }}>{field.name}</div>
                    <div className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                      {field.type}
                      {field.required ? " · required" : ""}
                      {fieldChoices.length > 0 ? ` · ${fieldChoices.join(", ")}` : ""}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button onClick={() => moveField(index, -1)} disabled={index === 0} className="rounded p-1 disabled:opacity-30" style={{ color: "var(--color-text-muted)" }}>↑</button>
                    <button onClick={() => moveField(index, 1)} disabled={index === fields.length - 1} className="rounded p-1 disabled:opacity-30" style={{ color: "var(--color-text-muted)" }}>↓</button>
                    <button
                      onClick={() => {
                        setEditingId(field.id);
                        setEditName(field.name);
                        setEditType(field.type);
                        setEditRequired(field.required);
                        setEditChoices(fieldChoices.join(", "));
                      }}
                      className="rounded p-1 text-xs"
                      style={{ color: "var(--color-accent)" }}
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => {
                        if (confirm(`Delete custom field "${field.name}"?`)) {
                          deleteMutation.mutate({ id: field.id });
                        }
                      }}
                      className="rounded p-1 text-xs"
                      style={{ color: "var(--color-danger)" }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {fields.length === 0 && <p className="py-8 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>No custom fields yet</p>}
      </div>
    </div>
  );
}
