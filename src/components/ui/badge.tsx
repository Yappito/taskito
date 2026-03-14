import * as React from "react";
import { cn } from "@/lib/utils";

/** Reusable badge component */
export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "secondary" | "destructive" | "outline";
}

/** Status/tag badge with color variants */
function Badge({ className, variant = "default", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variant === "outline" && "border",
        className
      )}
      style={{
        backgroundColor:
          variant === "outline"
            ? "transparent"
            : variant === "destructive"
              ? "var(--color-danger-muted)"
              : "var(--color-accent-muted)",
        color:
          variant === "destructive"
            ? "var(--color-danger)"
            : variant === "outline"
              ? "var(--color-text-secondary)"
              : "var(--color-accent)",
        borderColor: variant === "outline" ? "var(--color-border)" : undefined,
      }}
      {...props}
    />
  );
}

export { Badge };
