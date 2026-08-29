import type { ProjectMemberRole, ProjectPermission } from "@prisma/client";
import { createCallerFactory, type TRPCContext } from "@/server/trpc";

import { createPrismaMock, type PrismaMock } from "./prisma-mock";

/** Minimal session user shape required by the tRPC procedures under test. */
export interface SessionUserLike {
  id: string;
  role?: string;
}

/** Direct project membership the fixture wires into `prisma.user.findUnique`. */
export interface DirectMembershipFixture {
  projectId: string;
  role: ProjectMemberRole;
}

/** Explicit per-project permission grant (positive or negative). */
export interface PermissionGrantFixture {
  projectId: string;
  permission: ProjectPermission;
  allowed: boolean;
}

/** Group-derived project access: role plus optional permission grants. */
export interface GroupProjectFixture {
  projectId: string;
  role: ProjectMemberRole;
  grants?: Array<Omit<PermissionGrantFixture, "projectId">>;
}

export interface MemberFixtureInput {
  userId: string;
  /** Global user role; defaults to "member". */
  role?: "admin" | "member";
  /** When set, `getCurrentActor` rejects with "This account is disabled". */
  disabledAt?: Date | null;
  /** Direct project memberships keyed by project id. */
  projects?: Record<string, ProjectMemberRole>;
  /** Direct user-level permission grants. */
  grants?: PermissionGrantFixture[];
  /** Group-derived project memberships and grants. */
  groups?: GroupProjectFixture[];
}

export interface WiredActor {
  userId: string;
  sessionUser: { id: string; role: string };
  prisma: PrismaMock;
  user: { id: string; role: string; disabledAt: Date | null };
}

const ADMIN_USER_ID = "cmab8yxxp0000a0d0m0i0n0u1s0e0r0";

function relationWhere(selection: unknown): { projectId?: string; permission?: string } {
  if (!selection || typeof selection !== "object") {
    return {};
  }
  const where = (selection as { where?: unknown }).where;
  if (!where || typeof where !== "object") {
    return {};
  }
  const whereShape = where as { projectId?: unknown; permission?: unknown };
  return {
    projectId: typeof whereShape.projectId === "string" ? whereShape.projectId : undefined,
    permission: typeof whereShape.permission === "string" ? whereShape.permission : undefined,
  };
}

/**
 * Wires `prisma.user.findUnique` to mirror the exact `where`/`select` shapes
 * used by `src/server/authz.ts`:
 *
 * - `getCurrentActor` selects `{ id, role, disabledAt }` -> plain actor row.
 * - `getEffectiveProjectAccess` selects filtered `projectMemberships`,
 *   `projectPermissionGrants` and nested `groupMemberships` relations, so the
 *   fixture filters those relations by the requested `where.projectId` /
 *   `where.permission` exactly like Prisma would.
 * - Relation keys absent from the select are omitted from the result, which
 *   keeps authz's `projectMember.findUnique` fallback path reachable.
 */
function wireUserFindUnique(
  prisma: PrismaMock,
  fixture: { userId: string; role: string; disabledAt: Date | null },
  memberships: DirectMembershipFixture[],
  grants: PermissionGrantFixture[],
  groups: GroupProjectFixture[]
) {
  prisma.user.findUnique.mockImplementation(async (args?: {
    where?: { id?: string };
    select?: Record<string, unknown>;
  }) => {
    if (args?.where?.id !== fixture.userId) {
      return null;
    }

    const actor = { id: fixture.userId, role: fixture.role, disabledAt: fixture.disabledAt };
    const select = args.select;
    if (!select) {
      return actor;
    }

    const result: Record<string, unknown> = {};
    if ("projectMemberships" in select) {
      const where = relationWhere(select.projectMemberships);
      result.projectMemberships = memberships.filter(
        (membership) => !where.projectId || membership.projectId === where.projectId
      );
    }
    if ("projectPermissionGrants" in select) {
      const where = relationWhere(select.projectPermissionGrants);
      result.projectPermissionGrants = grants.filter(
        (grant) =>
          (!where.projectId || grant.projectId === where.projectId)
          && (!where.permission || grant.permission === where.permission)
      );
    }
    if ("groupMemberships" in select) {
      const groupRelation = (select.groupMemberships ?? {}) as { select?: { group?: { select?: Record<string, unknown> } } };
      const groupSelect = groupRelation.select?.group?.select ?? {};
      result.groupMemberships = groups.map((group) => {
        const inner: { group: Record<string, unknown> } = { group: {} };
        if ("projectMemberships" in groupSelect) {
          const where = relationWhere(groupSelect.projectMemberships);
          inner.group.projectMemberships =
            !where.projectId || group.projectId === where.projectId
              ? [{ projectId: group.projectId, role: group.role }]
              : [];
        }
        if ("projectPermissionGrants" in groupSelect) {
          const where = relationWhere(groupSelect.projectPermissionGrants);
          inner.group.projectPermissionGrants = (group.grants ?? [])
            .filter(
              (grant) =>
                (!where.projectId || group.projectId === where.projectId)
                && (!where.permission || grant.permission === where.permission)
            )
            .map((grant) => ({ ...grant, projectId: group.projectId }));
        }
        return inner;
      });
    }
    return { ...actor, ...result };
  });
}

/**
 * Wires `prisma.projectMember.findUnique` for the composite-key lookup used by
 * authz's fallback path: `where: { projectId_userId: { projectId, userId } }`.
 * Returns the fixture's role when the user is a direct member, else null.
 */
function wireProjectMemberLookup(
  prisma: PrismaMock,
  userId: string,
  projects: Record<string, ProjectMemberRole>
) {
  prisma.projectMember.findUnique.mockImplementation(async (args?: {
    where?: { projectId_userId?: { projectId?: string; userId?: string } };
  }) => {
    const key = args?.where?.projectId_userId;
    if (!key || key.userId !== userId) {
      return null;
    }
    const role = key.projectId ? projects[key.projectId] : undefined;
    return role ? { role } : null;
  });
}

/**
 * Builds a shared prisma mock plus an authz-shaped actor: a member of the
 * given projects (`projects: { projectId -> role }`) with optional direct
 * grants, group-derived access, a global role override and `disabledAt`.
 */
export function memberOf(input: MemberFixtureInput): WiredActor {
  const role = input.role ?? "member";
  const disabledAt = input.disabledAt ?? null;
  const projects = input.projects ?? {};
  const memberships: DirectMembershipFixture[] = Object.entries(projects).map(([projectId, memberRole]) => ({
    projectId,
    role: memberRole,
  }));
  const grants = input.grants ?? [];
  const groups = input.groups ?? [];

  const prisma = createPrismaMock();
  wireUserFindUnique(prisma, { userId: input.userId, role, disabledAt }, memberships, grants, groups);
  wireProjectMemberLookup(prisma, input.userId, projects);

  return {
    userId: input.userId,
    sessionUser: { id: input.userId, role },
    prisma,
    user: { id: input.userId, role, disabledAt },
  };
}

/** Global administrator actor (bypasses project membership checks). */
export function adminUser(): WiredActor {
  return memberOf({ userId: ADMIN_USER_ID, role: "admin" });
}

type CallerFactoryArg = Parameters<typeof createCallerFactory>[0];

/**
 * Builds a tRPC caller for `router` with the given prisma mock and session
 * user (`{ id, role }`), mirroring `createTRPCContext` in production.
 */
export function callerFor(
  router: CallerFactoryArg,
  prisma: unknown,
  user: SessionUserLike
): Record<string, (input?: unknown) => Promise<unknown>> {
  const createCaller = createCallerFactory(router as Parameters<typeof createCallerFactory>[0]);
  return createCaller({
    prisma,
    session: { user, expires: "" },
  } as unknown as TRPCContext) as unknown as Record<
    string,
    (input?: unknown) => Promise<unknown>
  >;
}