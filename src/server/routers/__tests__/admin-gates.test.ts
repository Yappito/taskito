import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TRPCError } from "@trpc/server";

const { storageSettingsFindUnique } = vi.hoisted(() => ({
  storageSettingsFindUnique: vi.fn(),
}));

// The storage settings service resolves its prisma client at module scope, so
// the module itself is replaced: storage.get must never touch a real database.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    storageSettings: {
      findUnique: storageSettingsFindUnique,
    },
  },
}));

import { encryptSecret } from "@/lib/secret-crypto";
import { groupRouter } from "@/server/routers/group";
import { oidcRouter } from "@/server/routers/oidc";
import { storageRouter } from "@/server/routers/storage";
import { userRouter } from "@/server/routers/user";
import { adminUser, callerFor, memberOf } from "@/test/actors";

const CUID = "cmab8yxxp0001i7p4k8n2v3q4";
const MEMBER_CALLER_ID = "cmab8yxxp0000m0e0m0b0e0r0u0s0e0";

/**
 * Every adminProcedure in these four routers, enumerated by reading the router
 * files. The "enumeration" tests below cross-check these lists against the
 * actual procedure records of each router so a newly added procedure cannot
 * silently skip gate coverage.
 */
const ADMIN_PROCEDURES: Record<string, readonly string[]> = {
  group: ["list", "listPermissions", "create", "update", "delete"],
  oidc: ["list", "create", "update", "delete"],
  storage: ["get", "save", "clearOverride"],
  user: ["list", "create", "update", "delete"],
};

// Routers whose every procedure is admin-gated.
const FULLY_ADMIN_ROUTERS = ["group", "oidc", "storage"];

// user.ts also exposes protected (non-admin) procedures — enumerated so any
// change to the full procedure surface must update this file.
const NON_ADMIN_USER_PROCEDURES = [
  "me",
  "aiPreferences",
  "appearance",
  "updateAiPreferences",
  "updateAppearance",
  "updateProfile",
  "changePassword",
];

const ROUTERS: Record<string, unknown> = {
  group: groupRouter,
  oidc: oidcRouter,
  storage: storageRouter,
  user: userRouter,
};

function routerProcedureNames(router: unknown): string[] {
  const procedures = (router as { _def?: { procedures?: Record<string, unknown> } })._def
    ?.procedures;
  if (!procedures) {
    throw new Error("Router exposes no _def.procedures record to enumerate");
  }
  return Object.keys(procedures);
}

function addProcedures(routerName: string, procedure: string): string {
  return `${routerName}.${procedure}`;
}

describe("admin procedure enumeration", () => {
  it("matches every procedure of the fully-admin routers", () => {
    for (const routerName of FULLY_ADMIN_ROUTERS) {
      expect(routerProcedureNames(ROUTERS[routerName]).sort()).toEqual(
        [...ADMIN_PROCEDURES[routerName]].sort()
      );
    }
  });

  it("matches the known procedures of the user router (admin set is complete)", () => {
    expect(routerProcedureNames(userRouter).sort()).toEqual(
      [...ADMIN_PROCEDURES.user, ...NON_ADMIN_USER_PROCEDURES].sort()
    );
  });
});

describe("admin procedure gates deny plain members", () => {
  it.each(
    Object.entries(ADMIN_PROCEDURES).flatMap(([routerName, procedures]) =>
      procedures.map((procedure) => [addProcedures(routerName, procedure), routerName, procedure])
    )
  )("%s returns FORBIDDEN for role=member", async (_label, routerName, procedure) => {
    const actor = memberOf({ userId: MEMBER_CALLER_ID, projects: {} });
    const caller = callerFor(
      ROUTERS[routerName] as Parameters<typeof callerFor>[0],
      actor.prisma,
      actor.sessionUser
    );

    await expect(
      (caller as Record<string, (input?: unknown) => Promise<unknown>>)[procedure]({ id: CUID })
    ).rejects.toMatchObject({ code: "FORBIDDEN" satisfies TRPCError["code"] });
  });
});

describe("admin-facing serializers never leak secrets", () => {
  beforeAll(() => {
    process.env.AI_SECRET_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    process.env.OIDC_PROVIDERS = JSON.stringify([
      {
        id: "env-provider",
        name: "Env Provider",
        issuer: "https://accounts.example.com",
        clientId: "env-client",
        clientSecret: "clear-env-oidc-secret",
      },
    ]);
  });

  afterAll(() => {
    delete process.env.AI_SECRET_MASTER_KEY;
    delete process.env.OIDC_PROVIDERS;
  });

  it("oidc.list never exposes client secrets for database or env providers", async () => {
    const actor = adminUser();
    actor.prisma.oidcProviderConnection.findMany.mockResolvedValue([
      {
        id: CUID,
        providerId: "keycloak",
        name: "Keycloak",
        issuer: "https://keycloak.example.com/realms/taskito",
        clientId: "taskito-client",
        encryptedClientSecret: encryptSecret("clear-database-oidc-secret"),
        scope: "openid email profile",
        groupsClaim: "groups",
        defaultRole: "member",
        allowSignup: true,
        allowEmailAccountLinking: false,
        requireEmailVerified: false,
        adminEmails: [],
        isEnabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        // A stray plaintext field that must never be forwarded either:
        clientSecret: "stray-plaintext-secret",
      },
    ]);

    const caller = callerFor(oidcRouter, actor.prisma, actor.sessionUser);
    const result = (await caller.list()) as {
      providers: Array<Record<string, unknown>>;
      envProviders: Array<Record<string, unknown>>;
    };

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      providerId: "keycloak",
      hasClientSecret: true,
    });
    expect(result.envProviders).toEqual([
      expect.objectContaining({ providerId: "env-provider", hasClientSecret: true }),
    ]);

    const json = JSON.stringify(result);
    expect(json).not.toContain("clear-database-oidc-secret");
    expect(json).not.toContain("clear-env-oidc-secret");
    expect(json).not.toContain("stray-plaintext-secret");
    expect(json).not.toContain("encryptedClientSecret");
    expect(json).not.toContain('"clientSecret"');
    expect(json).not.toContain("v1:");
  });

  it("storage.get never returns the S3 secret or session token in clear", async () => {
    const actor = adminUser();
    const encryptedSecret = encryptSecret("clear-s3-secret-text");
    const encryptedToken = encryptSecret("clear-s3-session-token");
    storageSettingsFindUnique.mockResolvedValue({
      id: "default",
      provider: "s3",
      s3Bucket: "taskito-bucket",
      s3Region: "us-east-1",
      s3Endpoint: null,
      s3AccessKeyId: "AKIA-TEST-ACCESS",
      encryptedS3SecretAccessKey: encryptedSecret,
      encryptedS3SessionToken: encryptedToken,
      s3ForcePathStyle: false,
      s3Prefix: null,
    });

    const caller = callerFor(storageRouter, actor.prisma, actor.sessionUser);
    const payload = (await caller.get()) as {
      effective: Record<string, unknown>;
      database: Record<string, unknown> | null;
      environment: Record<string, unknown> | null;
    };

    expect(payload.effective).toMatchObject({
      provider: "s3",
      source: "database",
      hasS3SecretAccessKey: true,
      hasS3SessionToken: true,
    });
    expect(payload.database).toMatchObject({
      provider: "s3",
      hasS3SecretAccessKey: true,
    });
    expect(payload.environment).toBeNull();

    const json = JSON.stringify(payload);
    expect(json).not.toContain("clear-s3-secret-text");
    expect(json).not.toContain("clear-s3-session-token");
    expect(json).not.toContain(encryptedSecret);
    expect(json).not.toContain(encryptedToken);
    expect(json).not.toContain("encryptedS3SecretAccessKey");
    expect(json).not.toContain("encryptedS3SessionToken");
    expect(json).not.toContain('"secretAccessKey"');
    expect(json).not.toContain('"sessionToken"');
    expect(json).not.toContain("v1:");
  });
});