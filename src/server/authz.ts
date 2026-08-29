import { TRPCError } from "@trpc/server";
import type { Prisma, ProjectMemberRole, ProjectPermission } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type PrismaLike = typeof prisma | Prisma.TransactionClient;

export const PROJECT_PERMISSIONS = [
  "project_read",
  "project_manage",
  "project_delete",
  "member_manage",
  "task_read",
  "task_create",
  "task_update",
  "task_delete",
  "task_comment",
  "task_archive",
  "workflow_manage",
  "tag_manage",
  "custom_field_manage",
  "sprint_manage",
  "automation_manage",
  "ai_manage",
  "time_log",
] as const satisfies readonly ProjectPermission[];

export type ProjectPermissionKey = typeof PROJECT_PERMISSIONS[number];

interface ProjectAccessOptions {
  minimumRole?: ProjectMemberRole;
  permission?: ProjectPermission;
  permissions?: ProjectPermission[];
}

interface PermissionGrant {
  permission: ProjectPermission;
  allowed: boolean;
}

const projectRoleRank: Record<ProjectMemberRole, number> = {
  viewer: 0,
  member: 1,
  manager: 2,
  owner: 3,
};

const rolePermissions: Record<ProjectMemberRole, readonly ProjectPermission[]> = {
  viewer: ["project_read", "task_read"],
  member: [
    "project_read",
    "task_read",
    "task_create",
    "task_update",
    "task_comment",
    "task_archive",
    "time_log",
  ],
  manager: [
    "project_read",
    "project_manage",
    "member_manage",
    "task_read",
    "task_create",
    "task_update",
    "task_delete",
    "task_comment",
    "task_archive",
    "workflow_manage",
    "tag_manage",
    "custom_field_manage",
    "sprint_manage",
    "automation_manage",
    "ai_manage",
    "time_log",
  ],
  owner: PROJECT_PERMISSIONS,
};

function highestRole(roles: ProjectMemberRole[]) {
  return roles.reduce<ProjectMemberRole | null>((highest, role) => {
    if (!highest || projectRoleRank[role] > projectRoleRank[highest]) {
      return role;
    }
    return highest;
  }, null);
}

function applyPermissionGrants(basePermissions: Iterable<ProjectPermission>, grants: PermissionGrant[]) {
  const permissions = new Set<ProjectPermission>(basePermissions);
  const denied = new Set<ProjectPermission>();

  for (const grant of grants) {
    if (grant.allowed) {
      permissions.add(grant.permission);
    } else {
      denied.add(grant.permission);
    }
  }

  for (const permission of denied) {
    permissions.delete(permission);
  }

  return permissions;
}

function getRequiredPermissions(options?: ProjectAccessOptions) {
  if (options?.permissions?.length) {
    return options.permissions;
  }
  return [options?.permission ?? "project_read"] as ProjectPermission[];
}

/** Returns the current actor with their global role or fails if the user record is missing. */
export async function getCurrentActor(prisma: PrismaLike, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, disabledAt: true },
  });

  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  if (user.disabledAt) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This account is disabled" });
  }

  return user;
}

/** Options for admin checks. */
export interface RequireGlobalAdminOptions {
  /** Token-authenticated requests never receive admin powers (v1 decision). */
  authMethod?: "cookie" | "token";
}

/** Ensures that the current user is a global administrator (browser sessions only). */
export async function requireGlobalAdmin(
  prisma: PrismaLike,
  userId: string,
  options?: RequireGlobalAdminOptions
) {
  if (options?.authMethod === "token") {
    // Personal API tokens never grant admin — even for admin users.
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "This action is not available with API token authentication. Sign in with your browser instead.",
    });
  }
  const actor = await getCurrentActor(prisma, userId);
  if (actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return actor;
}

export async function getEffectiveProjectAccess(prisma: PrismaLike, userId: string, projectId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      disabledAt: true,
      projectMemberships: {
        where: { projectId },
        select: { role: true },
      },
      projectPermissionGrants: {
        where: { projectId },
        select: { permission: true, allowed: true },
      },
      groupMemberships: {
        select: {
          group: {
            select: {
              projectMemberships: {
                where: { projectId },
                select: { role: true },
              },
              projectPermissionGrants: {
                where: { projectId },
                select: { permission: true, allowed: true },
              },
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  if (user.disabledAt) {
    throw new TRPCError({ code: "FORBIDDEN", message: "This account is disabled" });
  }

  if (user.role === "admin") {
    return {
      actor: user,
      membershipRole: "owner" as ProjectMemberRole,
      permissions: new Set<ProjectPermission>(PROJECT_PERMISSIONS),
    };
  }

  const selectedUser = user as typeof user & {
    projectMemberships?: Array<{ role: ProjectMemberRole }>;
    groupMemberships?: Array<{
      group: {
        projectMemberships: Array<{ role: ProjectMemberRole }>;
        projectPermissionGrants: PermissionGrant[];
      };
    }>;
    projectPermissionGrants?: PermissionGrant[];
  };
  const fallbackMembership = selectedUser.projectMemberships === undefined
    ? await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      })
    : null;
  const directMemberships = selectedUser.projectMemberships ?? (fallbackMembership ? [fallbackMembership] : []);
  const groupMemberships = selectedUser.groupMemberships ?? [];
  const directGrants = selectedUser.projectPermissionGrants ?? [];
  const roles = [
    ...directMemberships.map((membership) => membership.role),
    ...groupMemberships.flatMap((membership) =>
      membership.group.projectMemberships.map((projectMembership) => projectMembership.role)
    ),
  ];
  const membershipRole = highestRole(roles);
  const basePermissions = membershipRole ? rolePermissions[membershipRole] : [];
  const grants = [
    ...groupMemberships.flatMap((membership) => membership.group.projectPermissionGrants),
    ...directGrants,
  ];

  return {
    actor: user,
    membershipRole,
    permissions: applyPermissionGrants(basePermissions, grants),
  };
}

/** Ensures that the current user can access the given project. */
export async function requireProjectAccess(
  prisma: PrismaLike,
  userId: string,
  projectId: string,
  options?: ProjectAccessOptions
) {
  const access = await getEffectiveProjectAccess(prisma, userId, projectId);

  if (options?.minimumRole) {
    if (!access.membershipRole || projectRoleRank[access.membershipRole] < projectRoleRank[options.minimumRole]) {
      throw new TRPCError({ code: "FORBIDDEN" });
    }
  }

  const requiredPermissions = getRequiredPermissions(options);
  if (!requiredPermissions.every((permission) => access.permissions.has(permission))) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }

  return {
    ...access,
    membershipRole: access.membershipRole ?? ("viewer" as ProjectMemberRole),
  };
}

export async function requireProjectPermission(
  prisma: PrismaLike,
  userId: string,
  projectId: string,
  permission: ProjectPermission
) {
  return requireProjectAccess(prisma, userId, projectId, { permission });
}

export async function canAccessProject(prisma: PrismaLike, userId: string, projectId: string) {
  try {
    await requireProjectAccess(prisma, userId, projectId);
    return true;
  } catch (error) {
    if (error instanceof TRPCError && (error.code === "FORBIDDEN" || error.code === "UNAUTHORIZED")) {
      return false;
    }
    throw error;
  }
}

/** Returns the set of project IDs visible to the current user. */
export async function getAccessibleProjectIds(
  prisma: PrismaLike,
  userId: string
): Promise<string[]> {
  const actor = await getCurrentActor(prisma, userId);
  if (actor.role === "admin") {
    const projects = await prisma.project.findMany({ select: { id: true } });
    return projects.map((project) => project.id);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      projectMemberships: { select: { projectId: true } },
      projectPermissionGrants: {
        where: { permission: "project_read" },
        select: { projectId: true, allowed: true },
      },
      groupMemberships: {
        select: {
          group: {
            select: {
              projectMemberships: { select: { projectId: true } },
              projectPermissionGrants: {
                where: { permission: "project_read" },
                select: { projectId: true, allowed: true },
              },
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  const projectIds = new Set<string>();
  const deniedProjectIds = new Set<string>();
  for (const membership of user.projectMemberships ?? []) {
    projectIds.add(membership.projectId);
  }
  for (const grant of user.projectPermissionGrants ?? []) {
    if (grant.allowed) {
      projectIds.add(grant.projectId);
    } else {
      deniedProjectIds.add(grant.projectId);
    }
  }
  for (const membership of user.groupMemberships ?? []) {
    for (const projectMembership of membership.group.projectMemberships) {
      projectIds.add(projectMembership.projectId);
    }
    for (const grant of membership.group.projectPermissionGrants) {
      if (grant.allowed) {
        projectIds.add(grant.projectId);
      } else {
        deniedProjectIds.add(grant.projectId);
      }
    }
  }
  for (const projectId of deniedProjectIds) {
    projectIds.delete(projectId);
  }

  return [...projectIds];
}

/** Resolves a task to its project and enforces access to that project. */
export async function requireTaskAccess(
  prisma: PrismaLike,
  userId: string,
  taskId: string,
  options?: ProjectAccessOptions
) {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { id: true, projectId: true, statusId: true },
  });

  if (!task) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  await requireProjectAccess(prisma, userId, task.projectId, {
    ...options,
    permission: options?.permission ?? (options?.permissions?.length ? undefined : "task_read"),
  });
  return task;
}

/** Resolves a tag to its project and enforces access to that project. */
export async function requireTagAccess(
  prisma: PrismaLike,
  userId: string,
  tagId: string,
  options?: ProjectAccessOptions
) {
  const tag = await prisma.tag.findUnique({
    where: { id: tagId },
    select: { id: true, projectId: true },
  });

  if (!tag) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  await requireProjectAccess(prisma, userId, tag.projectId, options);
  return tag;
}

/** Resolves a workflow status to its project and enforces access to that project. */
export async function requireWorkflowStatusAccess(
  prisma: PrismaLike,
  userId: string,
  statusId: string,
  options?: ProjectAccessOptions
) {
  const status = await prisma.workflowStatus.findUnique({
    where: { id: statusId },
    select: { id: true, projectId: true, category: true, isFinal: true, autoArchive: true, autoArchiveDays: true },
  });

  if (!status) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  await requireProjectAccess(prisma, userId, status.projectId, options);
  return status;
}

/** Resolves a workflow transition to its project and enforces access to that project. */
export async function requireWorkflowTransitionAccess(
  prisma: PrismaLike,
  userId: string,
  transitionId: string,
  options?: ProjectAccessOptions
) {
  const transition = await prisma.workflowTransition.findUnique({
    where: { id: transitionId },
    select: { id: true, projectId: true },
  });

  if (!transition) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  await requireProjectAccess(prisma, userId, transition.projectId, options);
  return transition;
}

/** Resolves a task link to its source task project and enforces access to that project. */
export async function requireTaskLinkAccess(
  prisma: PrismaLike,
  userId: string,
  linkId: string,
  options?: ProjectAccessOptions
) {
  const link = await prisma.taskLink.findUnique({
    where: { id: linkId },
    select: {
      id: true,
      sourceTask: { select: { projectId: true } },
      targetTask: { select: { projectId: true } },
    },
  });

  if (!link) {
    throw new TRPCError({ code: "NOT_FOUND" });
  }

  if (link.sourceTask.projectId !== link.targetTask.projectId) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Cross-project links are not allowed" });
  }

  await requireProjectAccess(prisma, userId, link.sourceTask.projectId, options ?? { permission: "task_read" });
  return link;
}
