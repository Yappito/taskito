import { Prisma } from "@prisma/client";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, adminProcedure, protectedProcedure } from "../trpc";
import { hashPassword, verifyPassword } from "@/lib/password";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/password-policy";

interface MembershipSyncClient {
  project: {
    findMany: typeof import("@/lib/prisma").prisma.project.findMany;
  };
  projectMember: {
    deleteMany: typeof import("@/lib/prisma").prisma.projectMember.deleteMany;
    findMany: typeof import("@/lib/prisma").prisma.projectMember.findMany;
    createMany: typeof import("@/lib/prisma").prisma.projectMember.createMany;
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function uniqueProjectIds(projectIds: string[] | undefined) {
  return [...new Set(projectIds ?? [])];
}

function getAiPreferences(settings: unknown) {
  const root = (settings ?? {}) as Record<string, unknown>;
  const preferences = (root.aiPreferences ?? {}) as Record<string, unknown>;

  return {
    sendOnEnter: preferences.sendOnEnter === true,
  };
}

async function syncProjectMemberships(
  prisma: MembershipSyncClient,
  userId: string,
  projectIds: string[]
) {
  const normalizedProjectIds = uniqueProjectIds(projectIds);

  if (normalizedProjectIds.length > 0) {
    const existingProjects = await prisma.project.findMany({
      where: { id: { in: normalizedProjectIds } },
      select: { id: true },
    });

    if (existingProjects.length !== normalizedProjectIds.length) {
      throw new Error("One or more selected projects do not exist");
    }
  }

  await prisma.projectMember.deleteMany({
    where: {
      userId,
      ...(normalizedProjectIds.length > 0
        ? { projectId: { notIn: normalizedProjectIds } }
        : {}),
    },
  });

  if (normalizedProjectIds.length === 0) {
    return;
  }

  const existingMemberships = await prisma.projectMember.findMany({
    where: {
      userId,
      projectId: { in: normalizedProjectIds },
    },
    select: { projectId: true },
  });

  const existingProjectIds = new Set(existingMemberships.map((membership) => membership.projectId));
  const membershipsToCreate = normalizedProjectIds
    .filter((projectId) => !existingProjectIds.has(projectId))
    .map((projectId) => ({
      userId,
      projectId,
      role: "member" as const,
    }));

  if (membershipsToCreate.length > 0) {
    await prisma.projectMember.createMany({
      data: membershipsToCreate,
      skipDuplicates: true,
    });
  }
}

/** User management router */
export const userRouter = createTRPCRouter({
  /** Read the current user's profile */
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        createdAt: true,
      },
    });
  }),

  aiPreferences: protectedProcedure.query(async ({ ctx }) => {
    const user = await ctx.prisma.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { settings: true },
    });

    return getAiPreferences(user.settings);
  }),

  updateAiPreferences: protectedProcedure
    .input(
      z.object({
        sendOnEnter: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUniqueOrThrow({
        where: { id: ctx.session.user.id },
        select: { settings: true },
      });

      const settings = (user.settings ?? {}) as Record<string, unknown>;

      await ctx.prisma.user.update({
        where: { id: ctx.session.user.id },
        data: {
          settings: {
            ...settings,
            aiPreferences: input,
          } as Prisma.InputJsonValue,
        },
      });

      return input;
    }),

  /** Update the current user's profile */
  updateProfile: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.user.update({
        where: { id: ctx.session.user.id },
        data: {
          name: input.name,
        },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          role: true,
          createdAt: true,
        },
      });
    }),

  /** Change the current user's password */
  changePassword: protectedProcedure
    .input(
      z.object({
        currentPassword: z.string().min(1),
        newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.session.user.id },
        select: {
          password: true,
        },
      });

      if (!user?.password) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Password login is not configured for this account" });
      }

      const verification = await verifyPassword(input.currentPassword, user.password);
      if (!verification.valid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Current password is incorrect" });
      }

      if (input.currentPassword === input.newPassword) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a new password different from the current one" });
      }

      await ctx.prisma.user.update({
        where: { id: ctx.session.user.id },
        data: {
          password: await hashPassword(input.newPassword),
        },
      });

      return { success: true };
    }),

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
        projectMemberships: {
          select: {
            projectId: true,
            role: true,
            project: {
              select: {
                id: true,
                name: true,
                key: true,
                slug: true,
              },
            },
          },
          orderBy: {
            project: {
              name: "asc",
            },
          },
        },
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
        password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
        role: z.enum(["admin", "member"]).default("member"),
        projectIds: z.array(z.string().cuid()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const hashed = await hashPassword(input.password);
      return ctx.prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            name: input.name.trim(),
            email: normalizeEmail(input.email),
            password: hashed,
            role: input.role,
          },
        });

        await syncProjectMemberships(tx, user.id, input.projectIds ?? []);

        return tx.user.findUniqueOrThrow({
          where: { id: user.id },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            createdAt: true,
            projectMemberships: {
              select: {
                projectId: true,
                role: true,
                project: {
                  select: {
                    id: true,
                    name: true,
                    key: true,
                    slug: true,
                  },
                },
              },
            },
          },
        });
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
        password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH).optional(),
        projectIds: z.array(z.string().cuid()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, password, projectIds, ...data } = input;
      const updateData: Record<string, unknown> = { ...data };
      if (typeof updateData.name === "string") {
        updateData.name = updateData.name.trim();
      }
      if (typeof updateData.email === "string") {
        updateData.email = normalizeEmail(updateData.email);
      }
      if (password) {
        updateData.password = await hashPassword(password);
      }
      return ctx.prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id },
          data: updateData,
        });

        if (projectIds !== undefined) {
          await syncProjectMemberships(tx, id, projectIds);
        }

        return tx.user.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            name: true,
            email: true,
            role: true,
            createdAt: true,
            projectMemberships: {
              select: {
                projectId: true,
                role: true,
                project: {
                  select: {
                    id: true,
                    name: true,
                    key: true,
                    slug: true,
                  },
                },
              },
            },
          },
        });
      });
    }),

  /** Delete a user */
  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      if (input.id === ctx.session.user.id) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "You cannot delete your own account" });
      }

      await ctx.prisma.user.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
