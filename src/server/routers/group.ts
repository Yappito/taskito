import { Prisma } from "@prisma/client";
import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { PROJECT_PERMISSIONS } from "@/server/authz";
import { adminProcedure, createTRPCRouter } from "@/server/trpc";

const projectRoleSchema = z.enum(["viewer", "member", "manager", "owner"]);
const projectPermissionSchema = z.enum(PROJECT_PERMISSIONS);

const groupProjectAccessSchema = z.object({
  projectId: z.string().cuid(),
  role: projectRoleSchema,
});

const permissionGrantSchema = z.object({
  projectId: z.string().cuid(),
  permission: projectPermissionSchema,
  allowed: z.boolean(),
});

const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).nullable().optional(),
  memberIds: z.array(z.string().cuid()).optional(),
  projectAccess: z.array(groupProjectAccessSchema).optional(),
  permissionGrants: z.array(permissionGrantSchema).optional(),
});

function slugifyGroupName(name: string) {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);

  return slug || "group";
}

async function buildUniqueGroupSlug(prisma: Prisma.TransactionClient, name: string, exceptGroupId?: string) {
  const baseSlug = slugifyGroupName(name);
  let slug = baseSlug;
  let suffix = 2;

  while (await prisma.group.findFirst({
    where: {
      slug,
      ...(exceptGroupId ? { id: { not: exceptGroupId } } : {}),
    },
    select: { id: true },
  })) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return slug;
}

async function validateUsers(prisma: Prisma.TransactionClient, userIds: string[]) {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) {
    return [];
  }

  const users = await prisma.user.findMany({
    where: { id: { in: uniqueUserIds } },
    select: { id: true },
  });

  if (users.length !== uniqueUserIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "One or more users do not exist" });
  }

  return uniqueUserIds;
}

async function validateProjects(prisma: Prisma.TransactionClient, projectIds: string[]) {
  const uniqueProjectIds = [...new Set(projectIds)];
  if (uniqueProjectIds.length === 0) {
    return [];
  }

  const projects = await prisma.project.findMany({
    where: { id: { in: uniqueProjectIds } },
    select: { id: true },
  });

  if (projects.length !== uniqueProjectIds.length) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "One or more projects do not exist" });
  }

  return uniqueProjectIds;
}

async function syncGroupMembers(prisma: Prisma.TransactionClient, groupId: string, memberIds: string[] | undefined) {
  if (memberIds === undefined) {
    return;
  }

  const normalizedMemberIds = await validateUsers(prisma, memberIds);
  await prisma.groupMember.deleteMany({ where: { groupId } });

  if (normalizedMemberIds.length > 0) {
    await prisma.groupMember.createMany({
      data: normalizedMemberIds.map((userId) => ({ groupId, userId })),
      skipDuplicates: true,
    });
  }
}

async function syncGroupProjectAccess(
  prisma: Prisma.TransactionClient,
  groupId: string,
  projectAccess: z.infer<typeof groupProjectAccessSchema>[] | undefined
) {
  if (projectAccess === undefined) {
    return;
  }

  const normalizedAccess = Object.values(
    projectAccess.reduce<Record<string, z.infer<typeof groupProjectAccessSchema>>>((acc, access) => {
      acc[access.projectId] = access;
      return acc;
    }, {})
  );
  await validateProjects(prisma, normalizedAccess.map((access) => access.projectId));
  await prisma.projectGroup.deleteMany({
    where: {
      groupId,
      ...(normalizedAccess.length > 0 ? { projectId: { notIn: normalizedAccess.map((access) => access.projectId) } } : {}),
    },
  });

  await Promise.all(
    normalizedAccess.map((access) =>
      prisma.projectGroup.upsert({
        where: { projectId_groupId: { projectId: access.projectId, groupId } },
        create: { projectId: access.projectId, groupId, role: access.role },
        update: { role: access.role },
      })
    )
  );
}

async function syncGroupPermissionGrants(
  prisma: Prisma.TransactionClient,
  groupId: string,
  permissionGrants: z.infer<typeof permissionGrantSchema>[] | undefined
) {
  if (permissionGrants === undefined) {
    return;
  }

  const normalizedGrants = Object.values(
    permissionGrants.reduce<Record<string, z.infer<typeof permissionGrantSchema>>>((acc, grant) => {
      acc[`${grant.projectId}:${grant.permission}`] = grant;
      return acc;
    }, {})
  );
  await validateProjects(prisma, normalizedGrants.map((grant) => grant.projectId));
  await prisma.groupProjectPermissionGrant.deleteMany({ where: { groupId } });

  if (normalizedGrants.length > 0) {
    await prisma.groupProjectPermissionGrant.createMany({
      data: normalizedGrants.map((grant) => ({
        groupId,
        projectId: grant.projectId,
        permission: grant.permission,
        allowed: grant.allowed,
      })),
      skipDuplicates: true,
    });
  }
}

const groupSelect = {
  id: true,
  name: true,
  slug: true,
  description: true,
  source: true,
  oidcProvider: true,
  externalId: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
  members: {
    select: {
      role: true,
      user: { select: { id: true, name: true, email: true, image: true } },
    },
    orderBy: [{ user: { name: "asc" } }, { user: { email: "asc" } }],
  },
  projectMemberships: {
    select: {
      projectId: true,
      role: true,
      project: { select: { id: true, name: true, key: true, slug: true } },
    },
    orderBy: { project: { name: "asc" } },
  },
  projectPermissionGrants: {
    select: {
      projectId: true,
      permission: true,
      allowed: true,
    },
    orderBy: [{ projectId: "asc" }, { permission: "asc" }],
  },
} satisfies Prisma.GroupSelect;

export const groupRouter = createTRPCRouter({
  list: adminProcedure.query(async ({ ctx }) => {
    return ctx.prisma.group.findMany({
      select: groupSelect,
      orderBy: [{ source: "asc" }, { name: "asc" }],
    });
  }),

  listPermissions: adminProcedure.query(() => PROJECT_PERMISSIONS),

  create: adminProcedure
    .input(groupInputSchema)
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.$transaction(async (tx) => {
        const group = await tx.group.create({
          data: {
            name: input.name,
            slug: await buildUniqueGroupSlug(tx, input.name),
            description: input.description ?? null,
          },
        });

        await syncGroupMembers(tx, group.id, input.memberIds ?? []);
        await syncGroupProjectAccess(tx, group.id, input.projectAccess ?? []);
        await syncGroupPermissionGrants(tx, group.id, input.permissionGrants ?? []);

        return tx.group.findUniqueOrThrow({ where: { id: group.id }, select: groupSelect });
      });
    }),

  update: adminProcedure
    .input(groupInputSchema.partial().extend({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.group.findUniqueOrThrow({
        where: { id: input.id },
        select: { id: true, source: true },
      });

      if (group.source !== "local" && (input.name !== undefined || input.memberIds !== undefined)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "OIDC-managed groups cannot be renamed or edited manually" });
      }

      return ctx.prisma.$transaction(async (tx) => {
        if (input.name !== undefined || input.description !== undefined) {
          await tx.group.update({
            where: { id: input.id },
            data: {
              ...(input.name !== undefined ? { name: input.name, slug: await buildUniqueGroupSlug(tx, input.name, input.id) } : {}),
              ...(input.description !== undefined ? { description: input.description ?? null } : {}),
            },
          });
        }

        await syncGroupMembers(tx, input.id, input.memberIds);
        await syncGroupProjectAccess(tx, input.id, input.projectAccess);
        await syncGroupPermissionGrants(tx, input.id, input.permissionGrants);

        return tx.group.findUniqueOrThrow({ where: { id: input.id }, select: groupSelect });
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const group = await ctx.prisma.group.findUniqueOrThrow({
        where: { id: input.id },
        select: { source: true, isSystem: true },
      });

      if (group.isSystem || group.source !== "local") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Managed groups cannot be deleted manually" });
      }

      await ctx.prisma.group.delete({ where: { id: input.id } });
      return { success: true };
    }),
});
