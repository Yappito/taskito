import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCError } from "@trpc/server";

import { userRouter } from "@/server/routers/user";
import { adminUser, callerFor, memberOf } from "@/test/actors";

const USER_ID = "cmab8yxxp0000m0e0m0b0e0r0u0s0e";
const TOKEN_ID = "cmtok000000000000000000t1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("user.createApiToken", () => {
  it("stores only the hash and returns the plaintext exactly once", async () => {
    const actor = memberOf({ userId: USER_ID });
    actor.prisma.apiToken.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: TOKEN_ID,
      name: data.name,
      tokenPrefix: data.tokenPrefix,
      expiresAt: null,
      createdAt: new Date(),
    }));

    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser);
    const result = (await caller.createApiToken({ name: "CI script" })) as {
      token: string;
      tokenPrefix: string;
    };

    // The plaintext token matches the documented wire format...
    expect(result.token).toMatch(/^tk_[A-Za-z0-9_-]{43}$/);
    expect(result.tokenPrefix).toBe(result.token.slice(0, 8));

    // ...and the stored row contains the argon2 hash, not the plaintext.
    const createCall = actor.prisma.apiToken.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(createCall.data.userId).toBe(USER_ID);
    expect(createCall.data.name).toBe("CI script");
    expect(createCall.data.scopes).toEqual(["*"]);
    expect(createCall.data.tokenHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(createCall.data)).not.toContain(result.token);
  });

  it("honours expiresInDays", async () => {
    const actor = memberOf({ userId: USER_ID });
    actor.prisma.apiToken.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      id: TOKEN_ID,
      name: data.name,
      tokenPrefix: data.tokenPrefix,
      expiresAt: data.expiresAt as Date,
      createdAt: new Date(),
    }));

    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser);
    const result = (await caller.createApiToken({ name: "CI", expiresInDays: 30 })) as {
      expiresAt: Date;
    };

    const expected = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    expect(result.expiresAt).toBeDefined();
    expect(new Date(result.expiresAt).getTime()).toBeGreaterThanOrEqual(
      expected.getTime() - 60 * 60 * 1000
    );
  });

  it("rejects token authentication with FORBIDDEN", async () => {
    const actor = memberOf({ userId: USER_ID });
    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser, { authMethod: "token" });

    await expect(caller.createApiToken({ name: "from script" })).rejects.toMatchObject({
      code: "FORBIDDEN" satisfies TRPCError["code"],
    });
    expect(actor.prisma.apiToken.create).not.toHaveBeenCalled();
  });
});

describe("user.listApiTokens", () => {
  it("returns sanitized rows and never the hash", async () => {
    const actor = memberOf({ userId: USER_ID });
    const storedRow: Record<string, unknown> = {
      id: TOKEN_ID,
      name: "CI script",
      tokenPrefix: "tk_abcd12",
      tokenHash: "$argon2id$super-secret-hash-value",
      lastUsedAt: new Date("2026-08-01T10:00:00Z"),
      expiresAt: null,
      revokedAt: null,
      createdAt: new Date("2026-08-01T09:00:00Z"),
    };
    // Emulate Prisma: the projection keeps only the selected columns.
    actor.prisma.apiToken.findMany.mockImplementation(async (args?: { select?: Record<string, boolean> }) => {
      const select = args?.select;
      return [Object.fromEntries(Object.entries(storedRow).filter(([key]) => !select || select[key] === true))];
    });

    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser);
    const rows = (await caller.listApiTokens()) as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: TOKEN_ID,
      name: "CI script",
      tokenPrefix: "tk_abcd12",
      revokedAt: null,
    });
    expect(rows[0]).not.toHaveProperty("tokenHash");
    expect(JSON.stringify(rows)).not.toContain("super-secret-hash-value");
    expect(JSON.stringify(rows)).not.toContain("tokenHash");

    expect(actor.prisma.apiToken.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER_ID },
        select: {
          id: true,
          name: true,
          tokenPrefix: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          createdAt: true,
        },
      })
    );
  });

  it("rejects token authentication with FORBIDDEN", async () => {
    const actor = memberOf({ userId: USER_ID });
    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser, { authMethod: "token" });

    await expect(caller.listApiTokens()).rejects.toMatchObject({
      code: "FORBIDDEN" satisfies TRPCError["code"],
    });
  });
});

describe("user.revokeApiToken", () => {
  it("revokes a token owned by the caller", async () => {
    const actor = memberOf({ userId: USER_ID });
    actor.prisma.apiToken.findFirst.mockResolvedValue({ id: TOKEN_ID });
    actor.prisma.apiToken.update.mockResolvedValue({ id: TOKEN_ID, revokedAt: new Date() });

    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser);
    await expect(caller.revokeApiToken({ id: TOKEN_ID })).resolves.toEqual({ success: true });

    expect(actor.prisma.apiToken.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TOKEN_ID, userId: USER_ID } })
    );
    expect(actor.prisma.apiToken.update).toHaveBeenCalledWith({
      where: { id: TOKEN_ID },
      data: { revokedAt: expect.any(Date) },
    });
  });

  it("returns NOT_FOUND when revoking another user's token", async () => {
    const actor = memberOf({ userId: USER_ID });
    actor.prisma.apiToken.findFirst.mockResolvedValue(null);

    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser);
    await expect(caller.revokeApiToken({ id: TOKEN_ID })).rejects.toMatchObject({
      code: "NOT_FOUND" satisfies TRPCError["code"],
    });
    expect(actor.prisma.apiToken.update).not.toHaveBeenCalled();
  });

  it("rejects token authentication with FORBIDDEN", async () => {
    const actor = memberOf({ userId: USER_ID });
    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser, { authMethod: "token" });

    await expect(caller.revokeApiToken({ id: TOKEN_ID })).rejects.toMatchObject({
      code: "FORBIDDEN" satisfies TRPCError["code"],
    });
  });
});

describe("token sessions are capability-limited", () => {
  it("blocks account and token management procedures", async () => {
    const actor = memberOf({ userId: USER_ID });
    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser, { authMethod: "token" });

    await expect(
      caller.changePassword({ currentPassword: "old-password", newPassword: "brand-new-password" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" satisfies TRPCError["code"] });
    await expect(caller.updateProfile({ name: "New Name" })).rejects.toMatchObject({
      code: "FORBIDDEN" satisfies TRPCError["code"],
    });
  });

  it("never grants admin — even for admin users", async () => {
    const actor = adminUser();
    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser, { authMethod: "token" });

    await expect(caller.list({})).rejects.toMatchObject({
      code: "FORBIDDEN" satisfies TRPCError["code"],
    });
    expect(actor.prisma.user.findMany).not.toHaveBeenCalled();
    expect(actor.prisma.user.update).not.toHaveBeenCalled();
    expect(actor.prisma.user.delete).not.toHaveBeenCalled();
  });

  it("keeps admin procedures working for cookie sessions", async () => {
    const actor = adminUser();
    actor.prisma.user.findMany.mockResolvedValue([]);

    const caller = callerFor(userRouter, actor.prisma, actor.sessionUser);
    await expect(caller.list({})).resolves.toEqual([]);
  });
});