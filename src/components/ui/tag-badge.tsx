import * as React from "react";
import { cn } from "@/lib/utils";

const HEX_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Chip background blended from the tag colour (never the `${color}20` hex-suffix hack) */
export function tagChipBackground(color: string): string {
  return `color-mix(in srgb, ${color} 12%, transparent)`;
}

export interface TagChipStyle {
  backgroundColor: string;
  color: string;
}

/** Chip style for a tag colour, falling back to accent tokens for invalid/missing colours */
export function getTagChipStyle(color: string | null | undefined): TagChipStyle {
  const hex = color?.trim();
  if (hex && HEX_COLOR_PATTERN.test(hex)) {
    return { backgroundColor: tagChipBackground(hex), color: hex };
  }
  return { backgroundColor: "var(--color-accent-muted)", color: "var(--color-accent)" };
}

export interface TagLike {
  name: string;
  color?: string | null;
}

export interface TagBadgeProps {
  tag: TagLike;
  className?: string;
}

/** Single tag chip */
function TagBadge({ tag, className }: TagBadgeProps) {
  const style = getTagChipStyle(tag.color);
  return (
    <span
      className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs", className)}
      style={style}
    >
      {tag.name}
    </span>
  );
}

export interface TagBadgeListProps {
  tags: TagLike[];
  /** How many tags to render before collapsing into a +N chip */
  max?: number;
  className?: string;
  overflowClassName?: string;
}

/** Tag chip row with a +N overflow helper */
function TagBadgeList({ tags, max = 3, className, overflowClassName }: TagBadgeListProps) {
  const visible = tags.slice(0, Math.max(0, max));
  const overflow = tags.length - visible.length;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {visible.map((tag, index) => (
        <TagBadge key={`${tag.name}-${index}`} tag={tag} />
      ))}
      {overflow > 0 && (
        <span
          className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs", overflowClassName)}
          style={{
            backgroundColor: "var(--color-bg-muted)",
            color: "var(--color-text-muted)",
          }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

export { TagBadge, TagBadgeList };
