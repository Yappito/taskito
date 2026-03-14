"use client";

import { useMemo } from "react";

interface DependencyEdgeProps {
  id: string;
  points: Array<{ x: number; y: number }>;
  linkType: string;
  highlighted?: boolean;
}

/** Colour palette per link type — [main, light] */
const linkTypeColors: Record<string, [string, string]> = {
  blocks: ["#ef4444", "#fca5a5"],
  relates: ["#6b7280", "#d1d5db"],
  parent: ["#8b5cf6", "#c4b5fd"],
  child: ["#6366f1", "#a5b4fc"],
};

/** Stroke width per link type */
const linkThickness: Record<string, number> = {
  blocks: 3.5,
  relates: 2,
  parent: 2.5,
  child: 2.5,
};

/**
 * Build a rounded orthogonal path from the supplied bend points.
 */
function buildRoundedPath(points: Array<{ x: number; y: number }>, radius = 14): string {
  if (points.length === 0) return "";
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

  let path = `M ${points[0].x} ${points[0].y}`;

  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1];
    const current = points[i];
    const next = points[i + 1];

    if (!next) {
      path += ` L ${current.x} ${current.y}`;
      break;
    }

    const dxIn = current.x - previous.x;
    const dyIn = current.y - previous.y;
    const dxOut = next.x - current.x;
    const dyOut = next.y - current.y;

    const segmentIn = Math.hypot(dxIn, dyIn);
    const segmentOut = Math.hypot(dxOut, dyOut);
    if (segmentIn === 0 || segmentOut === 0) {
      path += ` L ${current.x} ${current.y}`;
      continue;
    }

    const cornerRadius = Math.min(radius, segmentIn / 2, segmentOut / 2);
    const startX = current.x - (dxIn / segmentIn) * cornerRadius;
    const startY = current.y - (dyIn / segmentIn) * cornerRadius;
    const endX = current.x + (dxOut / segmentOut) * cornerRadius;
    const endY = current.y + (dyOut / segmentOut) * cornerRadius;

    path += ` L ${startX} ${startY}`;
    path += ` Q ${current.x} ${current.y} ${endX} ${endY}`;
  }

  return path;
}

function getArrowAngle(points: Array<{ x: number; y: number }>): number {
  for (let i = points.length - 1; i > 0; i--) {
    const from = points[i - 1];
    const to = points[i];
    if (from.x !== to.x || from.y !== to.y) {
      return Math.atan2(to.y - from.y, to.x - from.x);
    }
  }

  return 0;
}

/** Clean rounded dependency edge with subtle casing and arrowhead */
export function DependencyEdge({
  id,
  points,
  linkType,
  highlighted,
}: DependencyEdgeProps) {
  const colours = linkTypeColors[linkType] ?? linkTypeColors.relates;
  const thickness = linkThickness[linkType] ?? 2.5;
  const strokeWidth = highlighted ? thickness + 1.25 : thickness;

  const gradientId = `edge-grad-${id}`;

  const edgePath = useMemo(() => buildRoundedPath(points), [points]);

  if (points.length < 2) return null;

  const start = points[0];
  const end = points[points.length - 1];
  const opacity = highlighted ? 0.78 : 0.42;

  const angle = getArrowAngle(points);
  const arrowSize = strokeWidth + 4;

  return (
    <g data-edge-id={id} className="dependency-edge no-theme-transition">
      <defs>
        <linearGradient id={gradientId} x1={start.x} y1={start.y} x2={end.x} y2={end.y} gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={colours[0]} stopOpacity={opacity * 0.85} />
          <stop offset="100%" stopColor={colours[1]} stopOpacity={opacity * 0.7} />
        </linearGradient>
      </defs>

      <path
        d={edgePath}
        fill="none"
        stroke="var(--color-bg-graph)"
        strokeWidth={strokeWidth + 4}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={highlighted ? 0.32 : 0.18}
      />

      <path
        d={edgePath}
        fill="none"
        stroke={`url(#${gradientId})`}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={opacity}
        strokeDasharray={linkType === "relates" ? "6,4" : undefined}
        className={highlighted ? "edge-flow-animated" : ""}
        strokeDashoffset={0}
      />

      <polygon
        points={`
          ${end.x},${end.y}
          ${end.x - arrowSize * Math.cos(angle - Math.PI / 5)},${end.y - arrowSize * Math.sin(angle - Math.PI / 5)}
          ${end.x - arrowSize * Math.cos(angle + Math.PI / 5)},${end.y - arrowSize * Math.sin(angle + Math.PI / 5)}
        `}
        fill={colours[0]}
        opacity={opacity}
      />
    </g>
  );
}
