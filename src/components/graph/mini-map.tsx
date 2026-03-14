"use client";

import type { GraphNode, GraphEdge, Viewport } from "@/lib/types";

interface MiniMapProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  graphWidth: number;
  graphHeight: number;
  viewport: Viewport;
  onNavigate: (x: number, y: number) => void;
  width?: number;
  height?: number;
}

/** Overview minimap with viewport rectangle and click navigation */
export function MiniMap({
  nodes,
  graphWidth,
  graphHeight,
  viewport,
  onNavigate,
  width = 200,
  height = 120,
}: MiniMapProps) {
  if (nodes.length === 0 || graphWidth === 0) return null;

  const scaleX = width / Math.max(graphWidth, 1);
  const scaleY = height / Math.max(graphHeight, 1);
  const scale = Math.min(scaleX, scaleY);

  const vpX = (-viewport.x / viewport.scale) * scale;
  const vpY = (-viewport.y / viewport.scale) * scale;
  const vpW = (viewport.width / viewport.scale) * scale;
  const vpH = (viewport.height / viewport.scale) * scale;

  function handleClick(e: React.MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const graphX = (clickX / scale) * viewport.scale;
    const graphY = (clickY / scale) * viewport.scale;

    onNavigate(
      -(graphX - viewport.width / 2),
      -(graphY - viewport.height / 2)
    );
  }

  return (
    <div
      className="absolute bottom-4 right-4 rounded-xl border p-1.5 backdrop-blur-md"
      style={{
        backgroundColor: "var(--color-minimap-bg)",
        borderColor: "var(--color-border)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <svg
        width={width}
        height={height}
        onClick={handleClick}
        className="cursor-crosshair"
      >
        <rect
          width={width}
          height={height}
          fill="var(--color-bg-muted)"
          rx={6}
        />

        {/* Node dots */}
        {nodes.map((node) => (
          <rect
            key={node.id}
            x={node.x * scale}
            y={node.y * scale}
            width={Math.max(node.width * scale, 2)}
            height={Math.max(node.height * scale, 2)}
            fill="var(--color-minimap-node)"
            rx={1}
          />
        ))}

        {/* Viewport rectangle */}
        <rect
          x={vpX}
          y={vpY}
          width={vpW}
          height={vpH}
          fill="var(--color-minimap-viewport)"
          stroke="var(--color-minimap-viewport-border)"
          strokeWidth={1.5}
          rx={3}
        />
      </svg>
    </div>
  );
}
