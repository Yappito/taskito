"use client";

import { useRef, useCallback, useEffect, useState } from "react";
import { zoom, zoomIdentity, select, type ZoomTransform, type D3ZoomEvent } from "d3";

interface ZoomToOptions {
  animate?: boolean;
  durationMs?: number;
}

/** Hook to manage D3 zoom/pan transform on an SVG element */
export function useTimelineZoom(svgRef: React.RefObject<SVGSVGElement | null>) {
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const zoomBehavior = useRef<ReturnType<typeof zoom<SVGSVGElement, unknown>> | null>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = select(svgRef.current);

    zoomBehavior.current = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 4])
      .filter((event: Event) => {
        // Don't zoom when interacting with connection ports or graph-node clicks
        const target = event.target as Element;
        if (target.closest?.(".connection-port")) return false;
        return true;
      })
      .on("zoom", (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        transformRef.current = event.transform;
        setTransform(event.transform);
      });

    svg.call(zoomBehavior.current);
    svg.on("wheel.zoom-interrupt mousedown.zoom-interrupt touchstart.zoom-interrupt", () => {
      svg.interrupt();
    });

    return () => {
      svg.on(".zoom", null);
      svg.on(".zoom-interrupt", null);
    };
  }, [svgRef]);

  const resetZoom = useCallback((options?: ZoomToOptions) => {
    if (!svgRef.current || !zoomBehavior.current) return;
    const svg = select(svgRef.current);
    svg.interrupt();

    if (options?.animate === false) {
      svg.call(zoomBehavior.current.transform, zoomIdentity);
      return;
    }

    svg
      .transition()
      .duration(options?.durationMs ?? 180)
      .call(zoomBehavior.current.transform, zoomIdentity);
  }, [svgRef]);

  const zoomTo = useCallback(
    (x: number, y: number, scale?: number, options?: ZoomToOptions) => {
      if (!svgRef.current || !zoomBehavior.current) return;
      const svg = select(svgRef.current);
      const newTransform = zoomIdentity
        .translate(x, y)
        .scale(scale ?? transformRef.current.k);
      svg.interrupt();

      if (options?.animate === false) {
        svg.call(zoomBehavior.current.transform, newTransform);
        return;
      }

      svg
        .transition()
        .duration(options?.durationMs ?? 180)
        .call(zoomBehavior.current.transform, newTransform);
    },
    [svgRef]
  );

  const zoomBy = useCallback(
    (factor: number, options?: ZoomToOptions) => {
      if (!svgRef.current || !zoomBehavior.current) return;
      const svg = select(svgRef.current);
      svg.interrupt();

      if (options?.animate === false) {
        svg.call(zoomBehavior.current.scaleBy, factor);
        return;
      }

      svg
        .transition()
        .duration(options?.durationMs ?? 140)
        .call(zoomBehavior.current.scaleBy, factor);
    },
    [svgRef]
  );

  return { transform, resetZoom, zoomTo, zoomBy };
}
