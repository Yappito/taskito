"use client";

import { useState, useEffect, useRef } from "react";
import type { LinkType } from "@/lib/types";

interface LinkTypePopupProps {
  x: number;
  y: number;
  onSelect: (linkType: LinkType) => void;
  onCancel: () => void;
}

const linkOptions: Array<{ type: LinkType; label: string; color: string }> = [
  { type: "blocks", label: "Blocks", color: "#ef4444" },
  { type: "relates", label: "Relates to", color: "#6b7280" },
  { type: "parent", label: "Parent of", color: "#8b5cf6" },
  { type: "child", label: "Child of", color: "#6366f1" },
];

/** Popup shown when completing a drag-to-link operation on the graph */
export function LinkTypePopup({ x, y, onSelect, onCancel }: LinkTypePopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<LinkType | null>(null);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  // Close on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) {
        onCancel();
      }
    }
    // Delay so the mouseup that triggers the popup doesn't immediately close it
    const tid = setTimeout(() => {
      document.addEventListener("mousedown", handleClick);
    }, 50);
    return () => {
      clearTimeout(tid);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onCancel]);

  return (
    <div
      ref={popupRef}
      className="absolute z-50 w-44 rounded-lg py-1"
      style={{
        left: x,
        top: y,
        backgroundColor: "var(--color-surface)",
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-lg)",
      }}
    >
      <div
        className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: "var(--color-text-muted)" }}
      >
        Link type
      </div>
      {linkOptions.map((opt) => (
        <button
          key={opt.type}
          onClick={() => onSelect(opt.type)}
          onMouseEnter={() => setHovered(opt.type)}
          onMouseLeave={() => setHovered(null)}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm transition-colors"
          style={{
            backgroundColor:
              hovered === opt.type ? "var(--color-surface-hover)" : "transparent",
            color: "var(--color-text)",
          }}
        >
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: opt.color }}
          />
          {opt.label}
        </button>
      ))}
    </div>
  );
}
