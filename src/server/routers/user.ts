import { z } from "zod";
import bcrypt from "bcryptjs";
import { createTRPCRouter, adminProcedure } from "../trpc";

/** User management router */
export const userRouter = createTRPCRouter({
  /** List all users */
  list: adminProcedure.query(async ({ ctx }) => {
    return ctx.prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        image: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }),

  /** Create a new user */
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        password: z.string().min(6).max(100),
        role: z.enum(["admin", "member"]).default("member"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const hashed = await bcrypt.hash(input.password, 12);
      return ctx.prisma.user.create({
        data: {
          name: input.name,
          email: input.email,
          password: hashed,
          role: input.role,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
        },
      });
    }),

  /** Update a user */
  update: adminProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        name: z.string().min(1).max(100).optional(),
        email: z.string().email().optional(),
        role: z.enum(["admin", "member"]).optional(),
        password: z.string().min(6).max(100).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, password, ...data } = input;
      const updateData: Record<string, unknown> = { ...data };
      if (password) {
        updateData.password = await bcrypt.hash(password, 12);
      }
      return ctx.prisma.user.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
        },
      });
    }),

  /** Delete a user */
  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.prisma.user.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
