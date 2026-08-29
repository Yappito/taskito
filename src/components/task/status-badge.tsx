"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { getTagChipStyle } from "@/components/ui/tag-badge";

interface StatusBadgeProps {
  name: string;
  color: string;
  className?: string;
}

/**
 * Colored badge showing workflow status.
 * Thin wrapper over the shared Badge primitive; the status color is blended
 * via color-mix instead of the old hex-alpha suffix hack.
 */
export function StatusBadge({ name, color, className }: StatusBadgeProps) {
  const chipStyle = getTagChipStyle(color);
  return (
    <Badge
      className={cn("gap-1.5", className)}
      style={{
        backgroundColor: chipStyle.backgroundColor,
        color: chipStyle.color,
      }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {name}
    </Badge>
  );
}