"use client";

import { useMemo } from "react";
import type { TimeResolution } from "@/lib/types";
import { createTimeScale, getTimeInterval, formatDateForResolution } from "@/lib/date-utils";

interface TimeAxisProps {
  startDate: Date;
  endDate: Date;
  width: number;
  height: number;
  resolution: TimeResolution;
}

/**
 * Time axis rendered in graph-space coordinates.
 *
 * Because the entire `<g>` parent is transformed by D3 zoom
 * (translate + scale), tick positions must use the **base** time scale only.
 * Using `rescaleX` on top would double-apply the zoom and cause labels
 * to drift away from the task nodes that were also placed via the base scale.
 */
export function TimeAxis({
  startDate,
  endDate,
  width,
  height,
  resolution,
}: TimeAxisProps) {
  const axisHeight = 44;

  const scale = useMemo(
    () => createTimeScale(startDate, endDate, width),
    [startDate, endDate, width]
  );

  const interval = getTimeInterval(resolution);
  const ticks = useMemo(() => {
    const domain = scale.domain();
    return interval.range(domain[0], domain[1]);
  }, [scale, interval]);

  const todayX = scale(new Date());

  return (
    <g className="time-axis no-theme-transition">
      {/* Background band */}
      <rect
        x={0}
        y={0}
        width={width}
        height={axisHeight}
        fill="var(--color-axis-bg)"
      />
      <line
        x1={0}
        y1={axisHeight}
        x2={width}
        y2={axisHeight}
        stroke="var(--color-axis-border)"
      />

      {/* Tick marks and labels */}
      {ticks.map((tick, i) => {
        const x = scale(tick);
        if (x < -50 || x > width + 50) return null;
        return (
          <g key={i} transform={`translate(${x}, 0)`}>
            <line
              y1={axisHeight - 8}
              y2={axisHeight}
              stroke="var(--color-axis-tick)"
            />
            <text
              y={axisHeight - 14}
              textAnchor="middle"
              fontSize={10}
              fill="var(--color-text-muted)"
            >
              {formatDateForResolution(tick, resolution)}
            </text>
            {/* Vertical gridline */}
            <line
              y1={axisHeight}
              y2={height}
              stroke="var(--color-grid-line)"
              strokeDasharray="4,4"
            />
          </g>
        );
      })}

      {/* Today marker */}
      {todayX >= 0 && todayX <= width && (
        <g transform={`translate(${todayX}, 0)`}>
          <line
            y1={0}
            y2={height}
            stroke="#ef4444"
            strokeWidth={1.5}
            opacity={0.5}
          />
          <rect
            x={-18}
            y={2}
            width={36}
            height={16}
            rx={8}
            fill="#ef4444"
            opacity={0.9}
          />
          <text
            y={14}
            textAnchor="middle"
            fontSize={9}
            fontWeight={600}
            fill="white"
          >
            Today
          </text>
        </g>
      )}
    </g>
  );
}
