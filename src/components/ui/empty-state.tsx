import * as React from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

/** Shared empty-state recipe: icon, title, description and an optional action slot */
function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg p-8 text-center",
        className
      )}
    >
      {icon != null && (
        <div
          className="mb-1.5 flex h-10 w-10 items-center justify-center rounded-full [&_svg]:h-5 [&_svg]:w-5"
          style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-muted)" }}
        >
          {icon}
        </div>
      )}
      <p className="text-sm font-medium" style={{ color: "var(--color-text)" }}>
        {title}
      </p>
      {description != null && (
        <p className="max-w-sm text-xs" style={{ color: "var(--color-text-muted)" }}>
          {description}
        </p>
      )}
      {action != null && <div className="mt-3">{action}</div>}
    </div>
  );
}

export { EmptyState };
