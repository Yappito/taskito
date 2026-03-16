import { z } from "zod";
import bcrypt from "bcryptjs";
import { createTRPCRouter, adminProcedure } from "../trpc";

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
        password: z.string().min(6).max(100),
        role: z.enum(["admin", "member"]).default("member"),
        projectIds: z.array(z.string().cuid()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const hashed = await bcrypt.hash(input.password, 12);
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
        password: z.string().min(6).max(100).optional(),
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
        updateData.password = await bcrypt.hash(password, 12);
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
      await ctx.prisma.user.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
