import { Prisma } from "@prisma/client";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { requireProjectAccess } from "@/server/authz";

import { createTRPCRouter, protectedProcedure } from "../trpc";

const customFieldTypeSchema = z.enum(["text", "number", "date", "select"]);

const customFieldOptionsSchema = z.object({
  choices: z.array(z.string().min(1).max(100)).optional(),
});

export const customFieldRouter = createTRPCRouter({
  list: protectedProcedure
    .input(z.object({ projectId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId);

      return ctx.prisma.customField.findMany({
        where: { projectId: input.projectId },
        orderBy: { order: "asc" },
      });
    }),

  upsert: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid().optional(),
        projectId: z.string().cuid(),
        name: z.string().min(1).max(100),
        type: customFieldTypeSchema,
        required: z.boolean().default(false),
        options: customFieldOptionsSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.id) {
        const existingField = await ctx.prisma.customField.findUnique({
          where: { id: input.id },
          select: { projectId: true },
        });

        if (!existingField) {
          throw new TRPCError({ code: "NOT_FOUND" });
        }

        await requireProjectAccess(ctx.prisma, ctx.session.user.id, existingField.projectId, {
          minimumRole: "owner",
        });

        if (existingField.projectId !== input.projectId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Custom field cannot be moved between projects" });
        }
      } else {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
          minimumRole: "owner",
        });
      }

      const normalizedOptions =
        input.type === "select"
          ? { choices: [...new Set(input.options?.choices?.map((choice) => choice.trim()).filter(Boolean) ?? [])] }
          : null;

      if (input.type === "select" && (!normalizedOptions?.choices || normalizedOptions.choices.length === 0)) {
        throw new Error("Select fields require at least one option");
      }

      if (input.id) {
        return ctx.prisma.customField.update({
          where: { id: input.id },
          data: {
            name: input.name,
            type: input.type,
            required: input.required,
            options: (normalizedOptions ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
          },
        });
      }

      const lastField = await ctx.prisma.customField.findFirst({
        where: { projectId: input.projectId },
        orderBy: { order: "desc" },
        select: { order: true },
      });

      return ctx.prisma.customField.create({
        data: {
          projectId: input.projectId,
          name: input.name,
          type: input.type,
          required: input.required,
          order: (lastField?.order ?? -1) + 1,
          options: (normalizedOptions ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
        },
      });
    }),

  reorder: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        fieldIds: z.array(z.string().cuid()),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        minimumRole: "owner",
      });

      const fields = await ctx.prisma.customField.findMany({
        where: {
          projectId: input.projectId,
          id: { in: input.fieldIds },
        },
        select: { id: true },
      });

      if (fields.length !== input.fieldIds.length) {
        throw new Error("One or more custom fields do not belong to this project");
      }

      await ctx.prisma.$transaction(
        input.fieldIds.map((fieldId, index) =>
          ctx.prisma.customField.update({
            where: { id: fieldId },
            data: { order: index },
          })
        )
      );

      return { success: true };
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const field = await ctx.prisma.customField.findUniqueOrThrow({
        where: { id: input.id },
        select: { id: true, projectId: true },
      });

      await requireProjectAccess(ctx.prisma, ctx.session.user.id, field.projectId, {
        minimumRole: "owner",
      });

      await ctx.prisma.customField.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
