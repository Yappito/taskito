import { TRPCError } from "@trpc/server";
import { describe, expect, it } from "vitest";

import {
  canAccessProject,
  getAccessibleProjectIds,
  getCurrentActor,
  getEffectiveProjectAccess,
  requireGlobalAdmin,
  requireProjectAccess,
  requireTaskAccess,
} from "@/server/authz";
import { adminUser, memberOf, type WiredActor } from "@/test/actors";

function expectTRPCError(promise: Promise<unknown>, code: TRPCError["code"]) {
  return expect(promise).rejects.toMatchObject({ code });
}

describe("getCurrentActor", () => {
  it("returns the user id, role, and disabledAt for an enabled user", async () => {
    const actor = memberOf({ userId: "user-1", role: "member" });

    await expect(getCurrentActor(actor.prisma as never, "user-1")).resolves.toEqual({
      id: "user-1",
      role: "member",
      disabledAt: null,
    });
  });

  it("rejects with UNAUTHORIZED when the user record is missing", async () => {
    const actor = memberOf({ userId: "user-1" });

    await expectTRPCError(
      getCurrentActor(actor.prisma as never, "someone-else"),
      "UNAUTHORIZED"
    );
  });

  it("rejects with a 'disabled' FORBIDDEN error when the account is disabled", async () => {
    const actor = memberOf({ userId: "user-1", disabledAt: new Date("2026-01-01T00:00:00.000Z") });

    await expectTRPCError(getCurrentActor(actor.prisma as never, "user-1"), "FORBIDDEN");
    await expect(getCurrentActor(actor.prisma as never, "user-1")).rejects.toThrow(
      /This account is disabled/
    );
  });
});

describe("requireGlobalAdmin", () => {
  it("resolves for a global admin", async () => {
    const actor = adminUser();

    await expect(requireGlobalAdmin(actor.prisma as never, actor.userId)).resolves.toEqual(
      expect.objectContaining({ role: "admin" })
    );
  });

  it("rejects plain members with FORBIDDEN", async () => {
    const actor = memberOf({ userId: "user-1" });

    await expectTRPCError(requireGlobalAdmin(actor.prisma as never, "user-1"), "FORBIDDEN");
  });
});

describe("requireProjectAccess", () => {
  it("rejects non-members with FORBIDDEN", async () => {
    const actor = memberOf({ userId: "user-1", projects: {} });

    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never),
      "FORBIDDEN"
    );
    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never, {
        permission: "task_read",
      }),
      "FORBIDDEN"
    );
  });

  it("lets viewers with task_read through but denies task_update", async () => {
    const actor = memberOf({ userId: "user-1", projects: { "project-a": "viewer" } });

    const access = await requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never);
    expect(access.membershipRole).toBe("viewer");

    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never, {
        permission: "task_update",
      }),
      "FORBIDDEN"
    );
  });

  it("lets members update tasks but denies manager-only permissions", async () => {
    const actor = memberOf({ userId: "user-1", projects: { "project-a": "member" } });

    await expect(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never, {
        permission: "task_update",
      })
    ).resolves.toEqual(expect.objectContaining({ membershipRole: "member" }));

    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never, {
        permission: "task_delete",
      }),
      "FORBIDDEN"
    );
  });

  it("rejects members below the required minimum role", async () => {
    const member = memberOf({ userId: "user-1", projects: { "project-a": "member" } });
    const owner = memberOf({ userId: "user-2", projects: { "project-a": "owner" } });

    await expectTRPCError(
      requireProjectAccess(member.prisma as never, "user-1", "project-a" as never, {
        minimumRole: "manager",
      }),
      "FORBIDDEN"
    );
    await expect(
      requireProjectAccess(owner.prisma as never, "user-2", "project-a" as never, {
        minimumRole: "owner",
      })
    ).resolves.toEqual(expect.objectContaining({ membershipRole: "owner" }));
  });

  it("lets an explicit { allowed: false } grant strip a role permission", async () => {
    const actor = memberOf({
      userId: "user-1",
      projects: { "project-a": "member" },
      grants: [{ projectId: "project-a", permission: "task_update", allowed: false }],
    });

    // task_read still comes from the member role...
    const access = await requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never);
    expect(access.permissions.has("task_read")).toBe(true);

    // ...but the denied task_update permission is stripped.
    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never, {
        permission: "task_update",
      }),
      "FORBIDDEN"
    );
  });

  it("lets an explicit { allowed: true } grant add a permission the role lacks", async () => {
    const actor = memberOf({
      userId: "user-1",
      projects: { "project-a": "viewer" },
      grants: [{ projectId: "project-a", permission: "task_update", allowed: true }],
    });

    const access = await requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never, {
      permission: "task_update",
    });
    expect(access.permissions.has("task_update")).toBe(true);
    expect(access.permissions.has("task_delete")).toBe(false);
  });

  it("grants access from group-derived membership when no direct membership exists", async () => {
    const actor = memberOf({
      userId: "user-1",
      projects: {},
      groups: [{ projectId: "project-a", role: "member" }],
    });

    const access = await getEffectiveProjectAccess(actor.prisma as never, "user-1", "project-a" as never);
    expect(access.membershipRole).toBe("member");
    expect(access.permissions.has("task_update")).toBe(true);

    // A group scoped to another project does not leak access to this one.
    const scoped = memberOf({
      userId: "user-2",
      projects: {},
      groups: [{ projectId: "project-b", role: "owner" }],
    });
    await expectTRPCError(
      requireProjectAccess(scoped.prisma as never, "user-2", "project-a" as never, {
        permission: "task_update",
      }),
      "FORBIDDEN"
    );
  });

  it("lets a group-level { allowed: false } grant strip a group role permission", async () => {
    const actor = memberOf({
      userId: "user-1",
      projects: {},
      groups: [
        {
          projectId: "project-a",
          role: "member",
          grants: [{ permission: "task_comment", allowed: false }],
        },
      ],
    });

    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never, {
        permission: "task_comment",
      }),
      "FORBIDDEN"
    );
  });

  it("bypasses membership checks for global admins", async () => {
    const actor: WiredActor = adminUser();

    const access = await requireProjectAccess(actor.prisma as never, actor.userId, "project-a" as never, {
      permission: "ai_manage",
    });
    expect(access.membershipRole).toBe("owner");
    expect(access.permissions.has("ai_manage")).toBe(true);
  });

  it("rejects a disabled member with the 'disabled' FORBIDDEN error", async () => {
    const actor = memberOf({
      userId: "user-1",
      projects: { "project-a": "owner" },
      disabledAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    await expect(getCurrentActor(actor.prisma as never, "user-1")).rejects.toThrow(
      /This account is disabled/
    );
    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-a" as never),
      "FORBIDDEN"
    );
  });

  it("rejects unknown projects with FORBIDDEN (does not leak existence via NOT_FOUND)", async () => {
    const actor = memberOf({ userId: "user-1", projects: { "project-a": "owner" } });

    // "project-does-not-exist" has no row anywhere; the loader simply finds no
    // membership for it, so the contract is FORBIDDEN rather than NOT_FOUND.
    await expectTRPCError(
      requireProjectAccess(actor.prisma as never, "user-1", "project-does-not-exist" as never),
      "FORBIDDEN"
    );
  });
});

describe("requireProjectAccess projectMember fallback", () => {
  function fallbackPrisma(actor: WiredActor, fallbackRole: { role: string } | null) {
    // Replace the relation-aware lookup with the narrow shape a caller without
    // membership selects would produce; authz must fall back to
    // prisma.projectMember.findUnique.
    actor.prisma.user.findUnique.mockImplementation(async () => ({
      id: actor.userId,
      role: "member",
      disabledAt: null,
    }));
    actor.prisma.projectMember.findUnique.mockResolvedValue(fallbackRole);
    return actor.prisma;
  }

  it("falls back to projectMember.findUnique when the user select omits relations", async () => {
    const actor = memberOf({ userId: "user-1", projects: { "project-a": "member" } });

    const access = await requireProjectAccess(
      fallbackPrisma(actor, { role: "member" }) as never,
      "user-1",
      "project-a" as never,
      { permission: "task_update" }
    );
    expect(access.membershipRole).toBe("member");
    expect(actor.prisma.projectMember.findUnique).toHaveBeenCalledWith({
      where: { projectId_userId: { projectId: "project-a", userId: "user-1" } },
      select: { role: true },
    });
  });

  it("rejects when the fallback membership is missing", async () => {
    const actor = memberOf({ userId: "user-1", projects: {} });

    await expectTRPCError(
      requireProjectAccess(
        fallbackPrisma(actor, null) as never,
        "user-1",
        "project-a" as never,
        { permission: "task_update" }
      ),
      "FORBIDDEN"
    );
  });
});

describe("requireTaskAccess", () => {
  it("rejects unknown tasks with NOT_FOUND", async () => {
    const actor = adminUser();
    actor.prisma.task.findUnique.mockResolvedValue(null);

    await expectTRPCError(
      requireTaskAccess(actor.prisma as never, actor.userId, "task-unknown" as never),
      "NOT_FOUND"
    );
  });

  it("rejects tasks whose project is inaccessible to the caller with FORBIDDEN", async () => {
    const actor = memberOf({ userId: "user-1", projects: { "project-a": "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: "task-1",
      projectId: "project-b",
      statusId: "status-1",
    });

    await expectTRPCError(
      requireTaskAccess(actor.prisma as never, "user-1", "task-1" as never),
      "FORBIDDEN"
    );
  });

  it("returns the task row when the caller can access its project", async () => {
    const actor = memberOf({ userId: "user-1", projects: { "project-a": "member" } });
    actor.prisma.task.findUnique.mockResolvedValue({
      id: "task-1",
      projectId: "project-a",
      statusId: "status-1",
    });

    await expect(requireTaskAccess(actor.prisma as never, "user-1", "task-1" as never)).resolves.toEqual(
      expect.objectContaining({ projectId: "project-a" })
    );
  });

});

describe("canAccessProject", () => {
  it("returns false for non-members instead of throwing", async () => {
    const actor = memberOf({ userId: "user-1", projects: {} });

    await expect(canAccessProject(actor.prisma as never, "user-1", "project-a" as never)).resolves.toBe(
      false
    );
    await expect(
      canAccessProject(actor.prisma as never, actor.userId, "project-b" as never)
    ).resolves.toBe(false);
  });
});

describe("getAccessibleProjectIds", () => {
  it("combines direct memberships, groups, grants, and removes denied projects", async () => {
    const actor = memberOf({
      userId: "user-1",
      projects: { "project-a": "member" },
      grants: [
        // A deny grant for a project the user is also a member of removes it.
        { projectId: "project-a", permission: "project_read", allowed: false },
        { projectId: "project-grant", permission: "project_read", allowed: true },
      ],
      groups: [{ projectId: "project-group", role: "member" }],
    });

    await expect(getAccessibleProjectIds(actor.prisma as never, "user-1")).resolves.toEqual([
      "project-grant",
      "project-group",
    ]);
  });

  it("lists every project id for global admins", async () => {
    const actor = adminUser();
    actor.prisma.project.findMany.mockResolvedValue([{ id: "project-1" }, { id: "project-2" }]);

    await expect(getAccessibleProjectIds(actor.prisma as never, actor.userId)).resolves.toEqual([
      "project-1",
      "project-2",
    ]);
  });
});