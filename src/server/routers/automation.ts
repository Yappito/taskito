import { Prisma } from "@prisma/client";
import { z } from "zod";

import { requireProjectAccess } from "@/server/authz";
import {
  getAutomationActionPermission,
  processDueDateAutomationRules,
  validateAutomationRuleReferences,
} from "@/server/services/automation-evaluator";
import { createTRPCRouter, protectedProcedure } from "@/server/trpc";

const automationTrigger = z.enum(["taskCreated", "statusChanged", "taskAssigned", "commentAdded", "dueDatePassed"]);
const automationAction = z.enum(["moveStatus", "assignTask", "addTag", "removeTag", "addComment", "archiveTask", "unarchiveTask"]);
const triggerConditionSchema = z.object({
  fromStatusId: z.string().cuid().optional(),
  toStatusId: z.string().cuid().optional(),
  statusId: z.string().cuid().optional(),
  assigneeId: z.string().cuid().nullable().optional(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
}).strict().partial();

const actionPayloadSchemas = {
  moveStatus: z.object({ taskId: z.string().cuid().optional(), statusId: z.string().cuid() }).strict(),
  assignTask: z.object({ taskId: z.string().cuid().optional(), assigneeId: z.string().cuid().nullable() }).strict(),
  addTag: z.object({ taskId: z.string().cuid().optional(), tagId: z.string().cuid() }).strict(),
  removeTag: z.object({ taskId: z.string().cuid().optional(), tagId: z.string().cuid() }).strict(),
  addComment: z.object({ taskId: z.string().cuid().optional(), content: z.string().trim().min(1).max(5000) }).strict(),
  archiveTask: z.object({ taskId: z.string().cuid().optional() }).strict(),
  unarchiveTask: z.object({ taskId: z.string().cuid().optional() }).strict(),
} as const satisfies Record<z.infer<typeof automationAction>, z.ZodTypeAny>;

const ruleInput = z.object({
  projectId: z.string().cuid(),
  name: z.string().trim().min(1).max(140),
  isEnabled: z.boolean().default(true),
  trigger: automationTrigger,
  triggerCondition: z.record(z.string(), z.unknown()).nullable().optional(),
  action: automationAction,
  actionPayload: z.record(z.string(), z.unknown()),
});

function validateRulePayload(input: { action: z.infer<typeof automationAction>; actionPayload?: Record<string, unknown>; triggerCondition?: Record<string, unknown> | null }) {
  const triggerCondition = input.triggerCondition == null ? null : triggerConditionSchema.parse(input.triggerCondition);
  const actionPayload = input.actionPayload === undefined ? undefined : actionPayloadSchemas[input.action].parse(input.actionPayload) as Record<string, unknown>;
  return { triggerCondition, actionPayload };
}

export const automationRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);
      return ctx.prisma.automationRule.findMany({
        where: { projectId: input.projectId },
        orderBy: [{ isEnabled: "desc" }, { createdAt: "desc" }],
      });
    }),

  create: protectedProcedure
    .input(ruleInput)
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "automation_manage" });
      // H3c at create time: authoring a rule for an action already requires the
      // permission that action needs (otherwise the scheduler would run a denied
      // action on the author's behalf later).
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        permission: getAutomationActionPermission(input.action),
      });
      const validated = validateRulePayload(input);
      await validateAutomationRuleReferences(ctx.prisma, input.projectId, {
        action: input.action,
        actionPayload: validated.actionPayload ?? {},
        triggerCondition: validated.triggerCondition,
        context: "Automation rule",
      });
      return ctx.prisma.automationRule.create({
        data: {
          projectId: input.projectId,
          // H3a: attribution — scheduled executions run as this user, so store
          // who authored the rule. The last-editor column (below) is the
          // execution principal for scheduled runs once the rule is edited.
          createdByUserId: ctx.session.user.id,
          // Finding 4: on create, creator and execution principal are the
          // same user.
          lastEditedByUserId: ctx.session.user.id,
          name: input.name,
          isEnabled: input.isEnabled,
          trigger: input.trigger,
          triggerCondition: (validated.triggerCondition ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          action: input.action,
          actionPayload: validated.actionPayload as Prisma.InputJsonValue,
        },
      });
    }),

  update: protectedProcedure
    .input(ruleInput.omit({ projectId: true }).partial().extend({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const rule = await ctx.prisma.automationRule.findUniqueOrThrow({
        where: { id: input.id },
        select: { projectId: true, action: true, createdByUserId: true, lastEditedByUserId: true },
      });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, rule.projectId, { permission: "automation_manage" });
      if (input.action !== undefined && input.actionPayload === undefined) {
        throw new Error("Changing an automation action requires a matching actionPayload");
      }
      const action = input.action ?? rule.action;
      // H3c at create/update time: editing or re-pointing an action requires
      // the permission the (resulting) action type needs.
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, rule.projectId, {
        permission: getAutomationActionPermission(action),
      });
      const validated = validateRulePayload({ action, actionPayload: input.actionPayload, triggerCondition: input.triggerCondition });
      await validateAutomationRuleReferences(ctx.prisma, rule.projectId, {
        action,
        actionPayload: validated.actionPayload ?? {},
        triggerCondition: validated.triggerCondition,
        context: "Automation rule",
      });
      return ctx.prisma.automationRule.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
          ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
          ...(input.triggerCondition !== undefined ? { triggerCondition: (validated.triggerCondition ?? Prisma.JsonNull) as Prisma.InputJsonValue } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          ...(input.actionPayload !== undefined ? { actionPayload: validated.actionPayload as Prisma.InputJsonValue } : {}),
          // H3a: keep the original creator for history; back-fill the column
          // when editing a rule created before it existed.
          createdByUserId: rule.createdByUserId ?? ctx.session.user.id,
          // Finding 4: any edit makes the EDITOR the execution principal for
          // scheduled runs. The previous behavior kept the original creator,
          // so an editor B could rewrite A's rule (e.g. repoint addComment at
          // arbitrary text) and the scheduled execution would author the
          // comment AS A — a non-repudiation/integrity failure. The action
          // permission re-check below already applies to the editor, and
          // resolveAutomationRuleActorId re-checks automation_manage + the
          // action permission against lastEditedByUserId at execution time.
          lastEditedByUserId: ctx.session.user.id,
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const rule = await ctx.prisma.automationRule.findUniqueOrThrow({ where: { id: input.id }, select: { projectId: true } });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, rule.projectId, { permission: "automation_manage" });
      await ctx.prisma.automationRule.delete({ where: { id: input.id } });
      return { success: true };
    }),

  runs: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), ruleId: z.string().cuid().optional() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "automation_manage" });
      return ctx.prisma.automationRun.findMany({
        where: { projectId: input.projectId, ...(input.ruleId ? { ruleId: input.ruleId } : {}) },
        include: { rule: { select: { id: true, name: true } }, task: { select: { id: true, taskNumber: true, title: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      });
    }),

  processDueDates: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), limit: z.number().int().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { permission: "automation_manage" });
      return processDueDateAutomationRules(ctx.prisma, {
        projectId: input.projectId,
        actorId: ctx.session.user.id,
        pageSize: input.limit,
      });
    }),
});