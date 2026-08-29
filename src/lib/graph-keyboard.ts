/**
 * Keyboard ordering helpers for the dependency graph.
 *
 * Nodes are visited in layout order: x first, then y, so left/right arrows
 * walk the graph roughly horizontally and up/down steps to a new row when
 * the x runs out.
 */
export interface GraphFocusNode {
  id: string;
  x: number;
  y: number;
}

/** Stable ids ordered by layout x then y (id breaks exact ties for determinism) */
export function getGraphFocusOrder(nodes: GraphFocusNode[]): string[] {
  return [...nodes]
    .sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))
    .map((node) => node.id);
}

/**
 * Index of the node that should receive focus when moving from `currentId`.
 * Returns null when there is nowhere to move (empty graph, unknown id, or
 * already at the edge with wrap disabled).
 */
export function getNextGraphFocusId(
  order: string[],
  currentId: string,
  direction: 1 | -1,
  wrap: boolean
): string | null {
  if (order.length === 0) return null;

  const index = order.indexOf(currentId);
  if (index === -1) return order[direction === 1 ? 0 : order.length - 1];

  let nextIndex = index + direction;
  if (wrap) {
    nextIndex = (nextIndex + order.length) % order.length;
  } else {
    nextIndex = Math.min(order.length - 1, Math.max(0, nextIndex));
  }

  if (nextIndex === index) return null;
  return order[nextIndex];
}
