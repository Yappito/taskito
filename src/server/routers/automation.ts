import { Prisma } from "@prisma/client";
import { z } from "zod";

import { requireProjectAccess } from "@/server/authz";
import { processDueDateAutomationRules } from "@/server/services/automation-evaluator";
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
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { minimumRole: "owner" });
      const validated = validateRulePayload(input);
      return ctx.prisma.automationRule.create({
        data: {
          projectId: input.projectId,
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
      const rule = await ctx.prisma.automationRule.findUniqueOrThrow({ where: { id: input.id }, select: { projectId: true } });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, rule.projectId, { minimumRole: "owner" });
      if (input.action !== undefined && input.actionPayload === undefined) {
        throw new Error("Changing an automation action requires a matching actionPayload");
      }
      const action = input.action ?? (await ctx.prisma.automationRule.findUniqueOrThrow({ where: { id: input.id }, select: { action: true } })).action;
      const validated = validateRulePayload({ action, actionPayload: input.actionPayload, triggerCondition: input.triggerCondition });
      return ctx.prisma.automationRule.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
          ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
          ...(input.triggerCondition !== undefined ? { triggerCondition: (validated.triggerCondition ?? Prisma.JsonNull) as Prisma.InputJsonValue } : {}),
          ...(input.action !== undefined ? { action: input.action } : {}),
          ...(input.actionPayload !== undefined ? { actionPayload: validated.actionPayload as Prisma.InputJsonValue } : {}),
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const rule = await ctx.prisma.automationRule.findUniqueOrThrow({ where: { id: input.id }, select: { projectId: true } });
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, rule.projectId, { minimumRole: "owner" });
      await ctx.prisma.automationRule.delete({ where: { id: input.id } });
      return { success: true };
    }),

  runs: protectedProcedure
    .input(z.object({ projectId: z.string().cuid(), ruleId: z.string().cuid().optional() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { minimumRole: "owner" });
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
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, { minimumRole: "owner" });
      return processDueDateAutomationRules(ctx.prisma, {
        projectId: input.projectId,
        actorId: ctx.session.user.id,
        limit: input.limit,
      });
    }),
});
