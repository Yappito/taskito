"use client";

import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  name: string;
  color: string;
  className?: string;
}

/** Colored badge showing workflow status */
export function StatusBadge({ name, color, className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        className
      )}
      style={{
        backgroundColor: `${color}20`,
        color: color,
      }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {name}
    </span>
  );
}
