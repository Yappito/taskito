"use client";

import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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

/** Inputs for a project's custom fields, rendered with the shared primitives */
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
              <Input
                value={value}
                onChange={(event) => onChange(field.id, event.target.value)}
              />
            )}

            {field.type === "number" && (
              <Input
                type="number"
                value={value}
                onChange={(event) => onChange(field.id, event.target.value)}
              />
            )}

            {field.type === "date" && (
              <Input
                type="date"
                value={value}
                onChange={(event) => onChange(field.id, event.target.value)}
              />
            )}

            {field.type === "select" && (
              <Select
                value={value}
                onChange={(event: ChangeEvent<HTMLSelectElement>) => onChange(field.id, event.target.value)}
              >
                <option value="">Select an option</option>
                {(field.options?.choices ?? []).map((choice) => (
                  <option key={choice} value={choice}>
                    {choice}
                  </option>
                ))}
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
}