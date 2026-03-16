"use client";

import type { ChangeEvent } from "react";

interface CustomFieldDefinition {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "select";
  required: boolean;
  options?: { choices?: string[] } | null;
}

export type TaskCustomFieldValueMap = Record<string, string>;

interface CustomFieldInputsProps {
  fields: CustomFieldDefinition[];
  values: TaskCustomFieldValueMap;
  onChange: (fieldId: string, value: string) => void;
}

export function CustomFieldInputs({ fields, values, onChange }: CustomFieldInputsProps) {
  if (fields.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {fields.map((field) => {
        const value = values[field.id] ?? "";

        return (
          <div key={field.id}>
            <label className="mb-1 block text-xs font-medium" style={{ color: "var(--color-text-secondary)" }}>
              {field.name}
              {field.required ? " *" : ""}
            </label>

            {field.type === "text" && (
              <input
                value={value}
                onChange={(event) => onChange(field.id, event.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text)",
                }}
              />
            )}

            {field.type === "number" && (
              <input
                type="number"
                value={value}
                onChange={(event) => onChange(field.id, event.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text)",
                }}
              />
            )}

            {field.type === "date" && (
              <input
                type="date"
                value={value}
                onChange={(event) => onChange(field.id, event.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text)",
                }}
              />
            )}

            {field.type === "select" && (
              <select
                value={value}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(field.id, event.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                style={{
                  backgroundColor: "var(--color-surface)",
                  borderColor: "var(--color-border)",
                  color: "var(--color-text)",
                }}
              >
                <option value="">Select an option</option>
                {(field.options?.choices ?? []).map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}