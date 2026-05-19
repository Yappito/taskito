export const TASK_DETAIL_SECTION_IDS = [
  "timeTracking",
  "recurrence",
  "dependencyWarning",
  "overview",
  "participants",
  "description",
  "comments",
  "details",
  "alert",
  "dependencies",
  "activity",
  "record",
] as const;

export type TaskDetailSectionId = (typeof TASK_DETAIL_SECTION_IDS)[number];
export type TaskDetailSectionDropPosition = "before" | "after";

export const DEFAULT_TASK_DETAIL_SECTION_ORDER: TaskDetailSectionId[] = [...TASK_DETAIL_SECTION_IDS];

const TASK_DETAIL_SECTION_ID_SET = new Set<TaskDetailSectionId>(TASK_DETAIL_SECTION_IDS);
const TASK_DETAIL_SECTION_ORDER_STORAGE_KEY = "taskito-task-detail-section-order";

export function isTaskDetailSectionId(value: string): value is TaskDetailSectionId {
  return TASK_DETAIL_SECTION_ID_SET.has(value as TaskDetailSectionId);
}

export function getTaskDetailSectionOrderStorageKey(projectId: string) {
  return `${TASK_DETAIL_SECTION_ORDER_STORAGE_KEY}:${projectId}`;
}

export function normalizeTaskDetailSectionOrder(value: unknown): TaskDetailSectionId[] {
  const orderedIds: TaskDetailSectionId[] = [];
  const seenIds = new Set<TaskDetailSectionId>();

  if (Array.isArray(value)) {
    value.forEach((candidate) => {
      if (typeof candidate !== "string") {
        return;
      }

      if (!TASK_DETAIL_SECTION_ID_SET.has(candidate as TaskDetailSectionId)) {
        return;
      }

      const sectionId = candidate as TaskDetailSectionId;
      if (seenIds.has(sectionId)) {
        return;
      }

      seenIds.add(sectionId);
      orderedIds.push(sectionId);
    });
  }

  DEFAULT_TASK_DETAIL_SECTION_ORDER.forEach((sectionId) => {
    if (!seenIds.has(sectionId)) {
      orderedIds.push(sectionId);
    }
  });

  return orderedIds;
}

export function moveTaskDetailSectionOrder(
  order: TaskDetailSectionId[],
  sourceId: TaskDetailSectionId,
  targetId: TaskDetailSectionId,
  position: TaskDetailSectionDropPosition
) {
  const normalizedOrder = normalizeTaskDetailSectionOrder(order);
  if (sourceId === targetId) {
    return normalizedOrder;
  }

  const nextOrder = normalizedOrder.filter((sectionId) => sectionId !== sourceId);
  const targetIndex = nextOrder.indexOf(targetId);
  if (targetIndex === -1) {
    return normalizedOrder;
  }

  const insertIndex = position === "after" ? targetIndex + 1 : targetIndex;
  nextOrder.splice(insertIndex, 0, sourceId);
  return normalizeTaskDetailSectionOrder(nextOrder);
}
