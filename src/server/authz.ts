import { TRPCError } from "@trpc/server";
import type { ProjectMemberRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";

type PrismaLike = typeof prisma;

interface ProjectAccessOptions {
  minimumRole?: ProjectMemberRole;
}

const projectRoleRank: Record<ProjectMemberRole, number> = {
  member: 0,
  owner: 1,
};

/** Returns the current actor with their global role or fails if the user record is missing. */
export async function getCurrentActor(prisma: PrismaLike, userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true },
  });

  if (!user) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }

  return user;
}

/** Ensures that the current user is a global administrator. */
export async function requireGlobalAdmin(prisma: PrismaLike, userId: string) {
  const actor = await getCurrentActor(prisma, userId);
  if (actor.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return actor;
}

/** Ensures that the current user can access the given project. */
export async function requireProjectAccess(
  prisma: PrismaLike,
  userId: string,
  projectId: string,
  options?: ProjectAccessOptions
) {
  const actor = await getCurrentActor(prisma, userId);
  if (actor.role === "admin") {
    return { actor, membershipRole: "owner" as ProjectMemberRole };
  }

  const membership = await prisma.projectMember.findUnique({
    where: {
      projectId_userId: {
        projectId,
        userId,
      },
    },
    select: { role: true },
  });

  if (!membership) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }

  const minimumRole = options?.minimumRole ?? "member";
  if (projectRoleRank[membership.role] < projectRoleRank[minimumRole]) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }

  return { actor, membershipRole: membership.role };
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

  const memberships = await prisma.projectMember.findMany({
    where: { userId },
    select: { projectId: true },
  });
  return memberships.map((membership) => membership.projectId);
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

  await requireProjectAccess(prisma, userId, task.projectId, options);
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

  await requireProjectAccess(prisma, userId, link.sourceTask.projectId, options);
  return link;
}