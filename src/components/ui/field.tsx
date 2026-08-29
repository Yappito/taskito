"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface FieldIds {
  /** Id to put on the control */
  id: string;
  labelId: string;
  hintId: string;
  errorId: string;
}

export interface FieldIdsWithDescriptions extends FieldIds {
  /** Value for the control's aria-describedby (hint and/or error, as rendered) */
  describedBy?: string;
}

/** Generates a stable id family for a field: control id plus label/hint/error ids */
export function useFieldIds(explicitId?: string): FieldIds {
  const generatedId = React.useId();
  const id = explicitId ?? generatedId;
  return React.useMemo(
    () => ({
      id,
      labelId: `${id}-label`,
      hintId: `${id}-hint`,
      errorId: `${id}-error`,
    }),
    [id]
  );
}

export interface FieldProps {
  label: React.ReactNode;
  /** Id of the control being labelled; generated via useId when omitted */
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  /** Control node(s), or a render prop receiving the field ids for full aria wiring */
  children: React.ReactNode | ((ids: FieldIdsWithDescriptions) => React.ReactNode);
}

/** Label + control + hint/error wrapper with generated, associated ids */
function Field({ label, htmlFor, hint, error, required = false, className, children }: FieldProps) {
  const ids = useFieldIds(htmlFor);
  const describedBy =
    [error != null ? ids.errorId : null, hint != null && error == null ? ids.hintId : null]
      .filter(Boolean)
      .join(" ") || undefined;
  const content =
    typeof children === "function" ? children({ ...ids, describedBy }) : children;

  return (
    <div className={cn("space-y-1", className)}>
      <label
        id={ids.labelId}
        htmlFor={ids.id}
        className="block text-xs font-medium"
        style={{ color: "var(--color-text-secondary)" }}
      >
        {label}
        {required && (
          <span aria-hidden="true" style={{ color: "var(--color-danger)" }}>
            {" "}*
          </span>
        )}
      </label>
      {content}
      {hint != null && error == null && (
        <p id={ids.hintId} className="text-xs" style={{ color: "var(--color-text-muted)" }}>
          {hint}
        </p>
      )}
      {error != null && (
        <p id={ids.errorId} role="alert" className="text-xs" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}

export { Field };
