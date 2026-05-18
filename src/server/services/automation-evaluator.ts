import type { AutomationAction, AutomationTrigger } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

type PrismaClient = typeof import("@/lib/prisma").prisma;

const automationContext = new AsyncLocalStorage<{ depth: number }>();

export function isAutomationExecutionActive() {
  return (automationContext.getStore()?.depth ?? 0) > 0;
}

function matchesCondition(condition: unknown, event: AutomationEvent) {
  if (!condition || typeof condition !== "object" || Array.isArray(condition)) {
    return true;
  }
  const record = condition as Record<string, unknown>;
  if (typeof record.fromStatusId === "string" && record.fromStatusId !== event.before?.statusId) return false;
  if (typeof record.toStatusId === "string" && record.toStatusId !== event.after?.statusId) return false;
  if (typeof record.statusId === "string" && record.statusId !== event.after?.statusId) return false;
  if (typeof record.assigneeId === "string" && record.assigneeId !== event.after?.assigneeId) return false;
  if (typeof record.priority === "string" && record.priority !== event.after?.priority) return false;
  return true;
}

interface AutomationEvent {
  projectId: string;
  trigger: AutomationTrigger;
  taskId?: string;
  actorId: string;
  before?: Record<string, string | null | undefined>;
  after?: Record<string, string | null | undefined>;
}

function getActionPayload(payload: unknown) {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
}

async function executeAutomationAction(
  prisma: PrismaClient,
  event: AutomationEvent,
  action: AutomationAction,
  rawPayload: unknown
) {
  const payload = getActionPayload(rawPayload);
  const targetTaskId = typeof payload.taskId === "string" ? payload.taskId : event.taskId;
  if (!targetTaskId) {
    throw new Error("Automation action requires a task target");
  }

  const [{ taskRouter }, { createCallerFactory }] = await Promise.all([
    import("@/server/routers/task"),
    import("@/server/trpc"),
  ]);
  const actor = await prisma.user.findUniqueOrThrow({
    where: { id: event.actorId },
    select: { role: true, email: true, name: true, image: true },
  });
  const createTaskCaller = createCallerFactory(taskRouter);
  const caller = createTaskCaller({
    prisma,
    session: {
      expires: new Date(Date.now() + 60_000).toISOString(),
      user: {
        id: event.actorId,
        role: actor.role === "admin" ? "admin" : "member",
        email: actor.email,
        name: actor.name,
        image: actor.image,
      },
    },
  });

  const depth = automationContext.getStore()?.depth ?? 0;
  return automationContext.run({ depth: depth + 1 }, async () => {
    switch (action) {
      case "moveStatus":
        if (typeof payload.statusId !== "string") throw new Error("moveStatus automation requires statusId");
        return caller.update({ id: targetTaskId, statusId: payload.statusId });
      case "assignTask":
        return caller.update({ id: targetTaskId, assigneeId: typeof payload.assigneeId === "string" ? payload.assigneeId : null });
      case "addTag":
        if (typeof payload.tagId !== "string") throw new Error("addTag automation requires tagId");
        return caller.addTags({ taskId: targetTaskId, tagIds: [payload.tagId] });
      case "removeTag":
        if (typeof payload.tagId !== "string") throw new Error("removeTag automation requires tagId");
        return caller.removeTag({ taskId: targetTaskId, tagId: payload.tagId });
      case "addComment":
        if (typeof payload.content !== "string" || !payload.content.trim()) throw new Error("addComment automation requires content");
        return caller.addComment({ taskId: targetTaskId, content: payload.content });
      case "archiveTask":
        return caller.archive({ id: targetTaskId });
      case "unarchiveTask":
        return caller.unarchive({ id: targetTaskId });
      default:
        throw new Error(`Unsupported automation action ${action}`);
    }
  });
}

export async function evaluateAutomationRules(prisma: PrismaClient, event: AutomationEvent) {
  if (isAutomationExecutionActive()) {
    return;
  }

  const rules = await prisma.automationRule.findMany({
    where: {
      projectId: event.projectId,
      isEnabled: true,
      trigger: event.trigger,
    },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  for (const rule of rules) {
    if (!matchesCondition(rule.triggerCondition, event)) {
      await prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          projectId: event.projectId,
          taskId: event.taskId,
          trigger: event.trigger,
          status: "skipped",
          message: "Trigger condition did not match",
        },
      }).catch(() => {});
      continue;
    }

    try {
      await executeAutomationAction(prisma, event, rule.action, rule.actionPayload);
      await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
      await prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          projectId: event.projectId,
          taskId: event.taskId,
          trigger: event.trigger,
          status: "success",
        },
      });
    } catch (error) {
      await prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          projectId: event.projectId,
          taskId: event.taskId,
          trigger: event.trigger,
          status: "failed",
          message: error instanceof Error ? error.message : "Automation action failed",
        },
      }).catch(() => {});
    }
  }
}

export async function processDueDateAutomationRules(
  prisma: PrismaClient,
  input: { projectId: string; actorId: string; now?: Date; limit?: number }
) {
  const now = input.now ?? new Date();
  const tasks = await prisma.task.findMany({
    where: {
      projectId: input.projectId,
      dueDate: { lte: now },
      OR: [{ archivedAt: null }, { archivedAt: { gt: now } }],
      status: { category: { notIn: ["done", "cancelled"] } },
    },
    select: { id: true, statusId: true, assigneeId: true, priority: true },
    orderBy: { dueDate: "asc" },
    take: input.limit ?? 100,
  });

  for (const task of tasks) {
    await evaluateAutomationRules(prisma, {
      projectId: input.projectId,
      trigger: "dueDatePassed",
      taskId: task.id,
      actorId: input.actorId,
      after: { statusId: task.statusId, assigneeId: task.assigneeId, priority: task.priority },
    });
  }

  return { processed: tasks.length };
}
