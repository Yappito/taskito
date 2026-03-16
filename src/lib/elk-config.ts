import type { GraphLayout, GraphNode, GraphEdge, GraphTaskData } from "@/lib/types";

interface LayoutInput {
  tasks: GraphTaskData[];
  links: Array<{
    id: string;
    sourceTaskId: string;
    targetTaskId: string;
    linkType: string;
  }>;
  timeScale: (date: Date) => number;
  nodeWidth?: number;
  nodeHeight?: number;
}

interface PositionedTask {
  task: GraphTaskData;
  x: number;
  y: number;
  lane: number;
}

interface TaskComponent {
  taskIds: string[];
  minDueTime: number;
}

const DEFAULT_NODE_WIDTH = 192;
const DEFAULT_NODE_HEIGHT = 80;
const NODE_GAP_X = 32;
const NODE_GAP_Y = 34;
const COMPONENT_GAP_Y = 56;

function getDueTime(task: GraphTaskData): number {
  return new Date(task.dueDate).getTime();
}

function buildEdgePoints(
  source: { x: number; y: number; w: number; h: number },
  target: { x: number; y: number; w: number; h: number }
): Array<{ x: number; y: number }> {
  const start = { x: source.x + source.w, y: source.y + source.h / 2 };
  const end = { x: target.x, y: target.y + target.h / 2 };

  if (start.x <= end.x) {
    const midX = start.x + Math.max((end.x - start.x) / 2, 36);
    return [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end];
  }

  const detourX = start.x + Math.max(source.w * 0.6, 72);
  return [start, { x: detourX, y: start.y }, { x: detourX, y: end.y }, end];
}

function getTaskComponents(tasks: GraphTaskData[], links: LayoutInput["links"]): TaskComponent[] {
  const taskIds = tasks.map((task) => task.id);
  const validTaskIds = new Set(taskIds);
  const adjacency = new Map<string, Set<string>>(
    taskIds.map((taskId) => [taskId, new Set<string>()])
  );

  for (const link of links) {
    if (!validTaskIds.has(link.sourceTaskId) || !validTaskIds.has(link.targetTaskId)) {
      continue;
    }

    adjacency.get(link.sourceTaskId)?.add(link.targetTaskId);
    adjacency.get(link.targetTaskId)?.add(link.sourceTaskId);
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const visited = new Set<string>();
  const components: TaskComponent[] = [];

  for (const taskId of taskIds) {
    if (visited.has(taskId)) continue;

    const queue = [taskId];
    const componentTaskIds: string[] = [];
    visited.add(taskId);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      componentTaskIds.push(currentId);

      for (const neighborId of adjacency.get(currentId) ?? []) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);
        queue.push(neighborId);
      }
    }

    const minDueTime = Math.min(
      ...componentTaskIds.map((id) => getDueTime(taskById.get(id)!))
    );

    components.push({
      taskIds: componentTaskIds,
      minDueTime,
    });
  }

  return components.sort((a, b) => a.minDueTime - b.minDueTime);
}

function getPreferredLane(
  taskId: string,
  neighborMap: Map<string, Set<string>>,
  placedLaneMap: Map<string, number>
): number {
  const placedNeighborLanes = [...(neighborMap.get(taskId) ?? [])]
    .map((neighborId) => placedLaneMap.get(neighborId))
    .filter((lane): lane is number => lane !== undefined)
    .sort((a, b) => a - b);

  if (placedNeighborLanes.length === 0) return 0;

  const middleIndex = Math.floor(placedNeighborLanes.length / 2);
  if (placedNeighborLanes.length % 2 === 1) {
    return placedNeighborLanes[middleIndex];
  }

  return Math.round(
    (placedNeighborLanes[middleIndex - 1] + placedNeighborLanes[middleIndex]) / 2
  );
}

function chooseLane(
  x: number,
  preferredLane: number,
  laneEnds: number[]
): number {
  const freeLanes = laneEnds
    .map((laneEnd, laneIndex) => ({ laneEnd, laneIndex }))
    .filter(({ laneEnd }) => x >= laneEnd + NODE_GAP_X)
    .sort((a, b) => {
      const preferredDistance = Math.abs(a.laneIndex - preferredLane) - Math.abs(b.laneIndex - preferredLane);
      if (preferredDistance !== 0) return preferredDistance;
      return a.laneIndex - b.laneIndex;
    });

  if (freeLanes.length > 0) {
    return freeLanes[0].laneIndex;
  }

  return laneEnds.length;
}

/**
 * Compute a timeline-first layout.
 *
 * X is always derived from the task due date, so the horizontal position maps
 * directly to the time axis. Y is packed into lanes to avoid overlap while
 * keeping the view compact.
 */
export async function computeGraphLayout({
  tasks,
  links,
  timeScale,
  nodeWidth = DEFAULT_NODE_WIDTH,
  nodeHeight = DEFAULT_NODE_HEIGHT,
}: LayoutInput): Promise<GraphLayout> {
  if (tasks.length === 0) {
    return { nodes: [], edges: [], width: 0, height: 0 };
  }

  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const validTaskIds = new Set(taskById.keys());
  const safeLinks = links.filter(
    (link) => validTaskIds.has(link.sourceTaskId) && validTaskIds.has(link.targetTaskId)
  );
  const neighborMap = new Map<string, Set<string>>(
    tasks.map((task) => [task.id, new Set<string>()])
  );

  for (const link of safeLinks) {
    neighborMap.get(link.sourceTaskId)?.add(link.targetTaskId);
    neighborMap.get(link.targetTaskId)?.add(link.sourceTaskId);
  }

  const components = getTaskComponents(tasks, safeLinks);
  const positioned: PositionedTask[] = [];
  let nextComponentOffsetY = 0;

  for (const component of components) {
    const componentTasks = component.taskIds
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is GraphTaskData => !!task)
      .sort((a, b) => getDueTime(a) - getDueTime(b) || a.title.localeCompare(b.title));

    const localLaneEnds: number[] = [];
    const localLaneMap = new Map<string, number>();
    const componentPositions: PositionedTask[] = componentTasks.map((task) => {
      const x = timeScale(new Date(task.dueDate));
      const preferredLane = getPreferredLane(task.id, neighborMap, localLaneMap);
      const lane = chooseLane(x, preferredLane, localLaneEnds);

      if (lane === localLaneEnds.length) {
        localLaneEnds.push(-Infinity);
      }

      localLaneEnds[lane] = x + nodeWidth;
      localLaneMap.set(task.id, lane);

      return {
        task,
        x,
        y: nextComponentOffsetY + lane * (nodeHeight + NODE_GAP_Y),
        lane,
      };
    });

    positioned.push(...componentPositions);

    const componentLaneCount = Math.max(localLaneEnds.length, 1);
    nextComponentOffsetY +=
      componentLaneCount * (nodeHeight + NODE_GAP_Y) - NODE_GAP_Y + COMPONENT_GAP_Y;
  }

  const nodeMap = new Map<string, { x: number; y: number; w: number; h: number }>();
  for (const node of positioned) {
    nodeMap.set(node.task.id, {
      x: node.x,
      y: node.y,
      w: nodeWidth,
      h: nodeHeight,
    });
  }

  const nodes: GraphNode[] = positioned.map((node) => {
    return {
      id: node.task.id,
      task: node.task,
      x: node.x,
      y: node.y,
      width: nodeWidth,
      height: nodeHeight,
    };
  });

  const graphEdges: GraphEdge[] = safeLinks.flatMap((edge) => {
    const sourceId = edge.sourceTaskId;
    const targetId = edge.targetTaskId;
    const srcNode = nodeMap.get(sourceId);
    const tgtNode = nodeMap.get(targetId);

    if (!srcNode || !tgtNode) return [];

    return {
      id: edge.id,
      source: sourceId,
      target: targetId,
      linkType: edge.linkType as GraphEdge["linkType"],
      points: buildEdgePoints(srcNode, tgtNode),
    };
  });

  const maxX = Math.max(...nodes.map((node) => node.x + node.width), nodeWidth);
  const maxY = Math.max(...nodes.map((node) => node.y + node.height), nodeHeight);

  return {
    nodes,
    edges: graphEdges,
    width: maxX + NODE_GAP_X,
    height: maxY + NODE_GAP_Y,
  };
}
