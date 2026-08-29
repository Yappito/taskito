import type { AutomationAction, AutomationTrigger, ProjectPermission } from "@prisma/client";
import { AsyncLocalStorage } from "node:async_hooks";

import { getEffectiveProjectAccess } from "@/server/authz";
import { assertTickAlive } from "@/server/services/scheduler-deadline";

type PrismaClient = typeof import("@/lib/prisma").prisma;

const automationContext = new AsyncLocalStorage<{ depth: number }>();

export function isAutomationExecutionActive() {
  return (automationContext.getStore()?.depth ?? 0) > 0;
}

/**
 * The project permission a user needs for an automation rule's action to
 * actually run. Enforced when the rule is created/updated (the author must
 * already hold it) and re-checked at execution time against the effective
 * actor — an `automation_manage` grant alone never authorizes the *action*.
 *
 * H3: without this, a user granted `automation_manage` but denied
 * `task_update`/`task_comment`/`task_archive` could have scheduled executions
 * perform the denied action on their behalf.
 */
export const AUTOMATION_ACTION_PERMISSIONS: Record<AutomationAction, ProjectPermission> = {
  moveStatus: "task_update",
  assignTask: "task_update",
  addTag: "task_update",
  removeTag: "task_update",
  addComment: "task_comment",
  archiveTask: "task_archive",
  unarchiveTask: "task_archive",
};

export function getAutomationActionPermission(action: AutomationAction): ProjectPermission {
  return AUTOMATION_ACTION_PERMISSIONS[action];
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

interface AutomationRuleRef {
  id: string;
  projectId: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  actionPayload: unknown;
  triggerCondition: unknown;
  createdByUserId: string | null;
  /** Execution principal: the user who last edited the rule (finding 4). */
  lastEditedByUserId: string | null;
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

/** True when a Prisma query error is a unique-constraint violation. */
function isUniqueConstraintError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/**
 * Effective project permissions for a user, reduced to a set. Never throws:
 * missing or disabled users and inaccessible projects yield an empty set.
 */
export async function getActorProjectPermissions(
  prisma: PrismaClient,
  userId: string,
  projectId: string
): Promise<Set<ProjectPermission>> {
  try {
    const access = await getEffectiveProjectAccess(prisma, userId, projectId);
    if (access.actor?.disabledAt) {
      return new Set<ProjectPermission>();
    }
    return access.permissions as Set<ProjectPermission>;
  } catch {
    return new Set<ProjectPermission>();
  }
}

/** Whether the actor currently holds the project permission `action` requires. */
export async function actorCanExecuteAutomationAction(
  prisma: PrismaClient,
  userId: string,
  projectId: string,
  action: AutomationAction
) {
  const permissions = await getActorProjectPermissions(prisma, userId, projectId);
  return permissions.has(AUTOMATION_ACTION_PERMISSIONS[action]);
}

/**
 * Validates that every referenced entity in an action payload belongs to the
 * rule's project: the optional target task, the moveStatus status, the tag and
 * the assignee. Throws with a descriptive error when any of them points
 * outside the rule's project (H3d: payloads may not smuggle in tasks,
 * statuses, tags, or assignees from other projects).
 */
async function assertPayloadReferencesInProject(
  prisma: PrismaClient,
  projectId: string,
  action: AutomationAction,
  payload: Record<string, unknown>,
  context: string
) {
  const taskId = typeof payload.taskId === "string" ? payload.taskId : null;
  if (taskId) {
    const task = await prisma.task.findFirst({
      where: { id: taskId, projectId },
      select: { id: true },
    });
    if (!task) {
      throw new Error(`${context}: target task is not in the rule's project`);
    }
  }

  if (action === "moveStatus" && typeof payload.statusId === "string") {
    const status = await prisma.workflowStatus.findFirst({
      where: { id: payload.statusId, projectId },
      select: { id: true },
    });
    if (!status) {
      throw new Error(`${context}: statusId does not belong to the rule's project`);
    }
  }

  if ((action === "addTag" || action === "removeTag") && typeof payload.tagId === "string") {
    const tag = await prisma.tag.findFirst({
      where: { id: payload.tagId, projectId },
      select: { id: true },
    });
    if (!tag) {
      throw new Error(`${context}: tagId does not belong to the rule's project`);
    }
  }

  if (action === "assignTask" && typeof payload.assigneeId === "string") {
    const member = await prisma.projectMember.findFirst({
      where: { projectId, userId: payload.assigneeId },
      select: { userId: true },
    });
    if (!member) {
      throw new Error(`${context}: assigneeId is not a project member`);
    }
  }
}

/**
 * Validates all id references of a rule (actionPayload and triggerCondition)
 * against the rule's project: statusId/fromStatusId/toStatusId must belong to
 * the project, assigneeId must be a project member. Throws when not; the
 * automation router calls this at create/update time.
 */
export async function validateAutomationRuleReferences(
  prisma: PrismaClient,
  projectId: string,
  input: {
    action: AutomationAction;
    actionPayload: unknown;
    triggerCondition?: unknown;
    context?: string;
  }
) {
  const context = input.context ?? "Automation rule";

  await assertPayloadReferencesInProject(
    prisma,
    projectId,
    input.action,
    getActionPayload(input.actionPayload),
    context,
  );

  const condition = input.triggerCondition;
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    const record = condition as Record<string, unknown>;
    for (const key of ["fromStatusId", "toStatusId", "statusId"] as const) {
      const statusId = record[key];
      if (typeof statusId === "string") {
        const status = await prisma.workflowStatus.findFirst({
          where: { id: statusId, projectId },
          select: { id: true },
        });
        if (!status) {
          throw new Error(`${context}: ${key} does not belong to the rule's project`);
        }
      }
    }
    const assigneeId = record.assigneeId;
    if (typeof assigneeId === "string") {
      const member = await prisma.projectMember.findFirst({
        where: { projectId, userId: assigneeId },
        select: { userId: true },
      });
      if (!member) {
        throw new Error(`${context}: assigneeId is not a project member`);
      }
    }
  }
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

  // H3d (execution-time re-check): the target task — explicit payload taskId or
  // the triggered task — must belong to the rule's project. Event targets are
  // already in the project's context, but a stored payload can reference a
  // task the rule's creator should never reach.
  const targetTask = await prisma.task.findUnique({
    where: { id: targetTaskId },
    select: { id: true, projectId: true },
  });
  if (!targetTask) {
    throw new Error("Automation action target task not found");
  }
  if (targetTask.projectId !== event.projectId) {
    throw new Error("Automation action target task is not in the rule's project");
  }

  await assertPayloadReferencesInProject(prisma, event.projectId, action, payload, "Automation action");

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

async function recordRun(
  prisma: PrismaClient,
  ruleId: string,
  event: Pick<AutomationEvent, "projectId" | "taskId" | "trigger">,
  status: "success" | "failed" | "skipped",
  message?: string
) {
  await prisma.automationRun.create({
    data: {
      ruleId,
      projectId: event.projectId,
      taskId: event.taskId,
      trigger: event.trigger,
      status,
      ...(message ? { message } : {}),
    },
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
  if (!Array.isArray(rules)) {
    return;
  }

  for (const rule of rules) {
    if (!matchesCondition(rule.triggerCondition, event)) {
      await recordRun(prisma, rule.id, event, "skipped", "Trigger condition did not match").catch(() => {});
      continue;
    }

    // H3c at execution time: whoever acts must hold the permission the rule's
    // action requires (e.g. an event actor with `task_update` but without
    // `task_comment` cannot trigger an addComment rule).
    if (!(await actorCanExecuteAutomationAction(prisma, event.actorId, event.projectId, rule.action))) {
      await recordRun(
        prisma,
        rule.id,
        event,
        "skipped",
        "Actor lacks the permission required for this rule's action",
      ).catch(() => {});
      continue;
    }

    try {
      await executeAutomationAction(prisma, event, rule.action, rule.actionPayload);
      await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
      await recordRun(prisma, rule.id, event, "success").catch(() => {});
    } catch (error) {
      await recordRun(
        prisma,
        rule.id,
        event,
        "failed",
        error instanceof Error ? error.message : "Automation action failed",
      ).catch(() => {});
    }
  }
}

/**
 * Resolves the scheduled execution principal for a rule: the LAST EDITOR
 * (AutomationRule.lastEditedByUserId, falling back to the creator for rules
 * that predate the column — they still run as their creator until the first
 * edit back-fills the attribution). Never the project owner, and never an
 * arbitrary "earliest member" fallback.
 *
 * Finding 4 (editor impersonation): attributing scheduled executions to the
 * original creator regardless of later edits let ANY editor with
 * automation_manage + the action permission rewrite a rule's payload (e.g.
 * repoint addComment at arbitrary text) while the generated content was still
 * authored AS the original creator. Running as the last editor means the
 * generated content is always attributed to whoever last shaped the rule —
 * and if that principal is missing, disabled, or no longer holds
 * `automation_manage` or the action's project permission, the rule is skipped
 * (with a warning), never executed as the project owner or another member on
 * their behalf.
 */
export async function resolveAutomationRuleActorId(
  prisma: PrismaClient,
  rule: Pick<AutomationRuleRef, "id" | "projectId" | "action" | "createdByUserId" | "lastEditedByUserId">
): Promise<string | null> {
  const prefix = `[automation] rule ${rule.id}`;
  // The execution principal is the last editor; un-edited legacy rules keep
  // running as their creator until someone edits them.
  const principalId = rule.lastEditedByUserId ?? rule.createdByUserId;

  if (!principalId) {
    console.warn(`${prefix} has no creator or last editor; skipping scheduled execution (rules created before creator attribution are never run by the scheduler)`);
    return null;
  }

  const principal = await prisma.user.findUnique({
    where: { id: principalId },
    select: { id: true, disabledAt: true },
  });
  if (!principal || principal.disabledAt) {
    console.warn(`${prefix} execution principal ${principalId} (last editor) is missing or disabled; skipping scheduled execution`);
    return null;
  }

  const permissions = await getActorProjectPermissions(prisma, principal.id, rule.projectId);
  const canManage = permissions.has("automation_manage");
  const canExecute = permissions.has(AUTOMATION_ACTION_PERMISSIONS[rule.action]);
  if (!canManage || !canExecute) {
    console.warn(
      `${prefix} execution principal ${principalId} (last editor) no longer holds the required project permissions ` +
        `(missing: ${[!canManage ? "automation_manage" : null, !canExecute ? AUTOMATION_ACTION_PERMISSIONS[rule.action] : null].filter(Boolean).join(", ")}); ` +
        "skipping scheduled execution",
    );
    return null;
  }

  return principal.id;
}

/**
 * Pages through a project's overdue tasks, oldest due date first, with a
 * cursor — the first page can no longer starve the rest of the backlog.
 */
async function* iterateOverdueTasks(
  prisma: PrismaClient,
  projectId: string,
  now: Date,
  input: { signal?: AbortSignal; pageSize?: number }
) {
  const pageSize = input.pageSize ?? 100;
  let cursorId: string | null = null;

  for (;;) {
    assertTickAlive(input.signal);
    const page: Array<{
      id: string;
      dueDate: Date;
      statusId: string;
      assigneeId: string | null;
      priority: string;
    }> = await prisma.task.findMany({
      where: {
        projectId,
        dueDate: { lte: now },
        OR: [{ archivedAt: null }, { archivedAt: { gt: now } }],
        status: { category: { notIn: ["done", "cancelled"] } },
      },
      select: { id: true, dueDate: true, statusId: true, assigneeId: true, priority: true },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: pageSize,
      ...(cursorId ? { skip: 1, cursor: { id: cursorId } } : {}),
    });

    for (const task of page) {
      yield task;
    }
    if (!Array.isArray(page) || page.length < pageSize) {
      return;
    }
    cursorId = page[page.length - 1].id;
  }
}

/**
 * Atomically claims the (rule, task, due-date occurrence) triple for firing.
 * Returns true only when this call owns the occurrence: the UNIQUE
 * (ruleId, taskId, dueDate) row is inserted before the action runs, which
 * makes the "fire once per overdue occurrence" guarantee atomic.
 */
async function claimDueDateFiring(
  prisma: PrismaClient,
  ruleId: string,
  taskId: string,
  dueDate: Date
): Promise<boolean> {
  try {
    await prisma.automationRuleFiring.create({
      data: { ruleId, taskId, dueDate },
    });
    return true;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      return false;
    }
    throw error;
  }
}

/**
 * Processes `dueDatePassed` rules for every project that has them.
 *
 * - Each rule runs as its **last editor** (AutomationRule.lastEditedByUserId);
 *   the creator is only used as a fallback for rules never edited after the
 *   column was introduced. When that principal is missing, disabled, or lost
 *   the required project permissions, the rule is skipped with a warning — it
 *   is never executed as the project owner or any other member on their behalf.
 *   This keeps generated content (comments, assignments, moves) attributed to
 *   whoever last shaped the rule instead of letting a second editor create
 *   content that looks like it came from the original author (finding 4).
 * - The transition to "overdue" is processed exactly once per (rule, task,
 *   due-date occurrence) via the AutomationRuleFiring claim table, so a
 *   long-overdue task can no longer produce a comment (or any other action)
 *   on every tick. The claim key includes the task's current due date, so
 *   changing the due date re-arms the rule for the new occurrence.
 * - Tasks page through with a cursor (no take-100 starvation).
 * - An optional `signal` stops processing between rules/pages so a scheduler
 *   tick aborts promptly at its deadline.
 *
 * When `input.actorId` is given (manual run from Project settings), all rules
 * for the scope run as that user; each rule's action permission is still
 * re-checked at execution time.
 */
export async function processDueDateAutomationRules(
  prisma: PrismaClient,
  input: { projectId?: string; actorId?: string; now?: Date; signal?: AbortSignal; pageSize?: number } = {}
) {
  const now = input.now ?? new Date();
  const rules = await prisma.automationRule.findMany({
    where: {
      isEnabled: true,
      trigger: "dueDatePassed",
      ...(input.projectId ? { projectId: input.projectId } : {}),
    },
    orderBy: [{ projectId: "asc" }, { createdAt: "asc" }],
  }) as unknown as AutomationRuleRef[];
  if (!Array.isArray(rules)) {
    return { processed: 0, fired: 0, skippedRules: 0 };
  }

  const byProject = new Map<string, AutomationRuleRef[]>();
  for (const rule of rules) {
    const group = byProject.get(rule.projectId) ?? [];
    group.push(rule);
    byProject.set(rule.projectId, group);
  }

  let processed = 0;
  let fired = 0;
  let skippedRules = 0;

  for (const [projectId, projectRules] of byProject) {
    assertTickAlive(input.signal);
    for (const rule of projectRules) {
      assertTickAlive(input.signal);

      let actorId: string | null | undefined = input.actorId;
      if (!actorId) {
        actorId = await resolveAutomationRuleActorId(prisma, rule);
      }
      if (!actorId) {
        skippedRules += 1;
        continue;
      }

      // H3c at execution time: scheduled and manual runs alike require the
      // underlying action permission for whoever acts.
      if (!(await actorCanExecuteAutomationAction(prisma, actorId, projectId, rule.action))) {
        console.warn(
          `[automation] rule ${rule.id} actor ${actorId} lacks the permission required for ${rule.action}; skipping`,
        );
        skippedRules += 1;
        continue;
      }

      let ruleFired = 0;
      for await (const task of iterateOverdueTasks(prisma, projectId, now, input)) {
        assertTickAlive(input.signal);
        processed += 1;

        if (!matchesCondition(rule.triggerCondition, {
          projectId,
          trigger: "dueDatePassed",
          taskId: task.id,
          actorId,
          after: { statusId: task.statusId, assigneeId: task.assigneeId, priority: task.priority },
        })) {
          continue;
        }

        const claimed = await claimDueDateFiring(prisma, rule.id, task.id, task.dueDate);
        if (!claimed) {
          continue;
        }

        const event: AutomationEvent = {
          projectId,
          trigger: "dueDatePassed",
          taskId: task.id,
          actorId,
          after: { statusId: task.statusId, assigneeId: task.assigneeId, priority: task.priority },
        };

        try {
          await executeAutomationAction(prisma, event, rule.action, rule.actionPayload);
          fired += 1;
          ruleFired += 1;
        } catch (error) {
          // Free the occurrence so a transient failure is retried on the next
          // tick instead of silently never firing again.
          await prisma.automationRuleFiring.deleteMany({
            where: { ruleId: rule.id, taskId: task.id, dueDate: task.dueDate },
          }).catch(() => {});
          await recordRun(
            prisma,
            rule.id,
            event,
            "failed",
            error instanceof Error ? error.message : "Automation action failed",
          ).catch(() => {});
          continue;
        }
        await recordRun(prisma, rule.id, event, "success").catch(() => {});
      }

      if (ruleFired > 0) {
        await prisma.automationRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } }).catch(() => {});
      }
    }
  }

  return { processed, fired, skippedRules };
}