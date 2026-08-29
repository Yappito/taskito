import { beforeEach, describe, expect, it, vi } from "vitest";

// createTRPCContext binds the process-wide prisma singleton, so the module is
// replaced with a proxy mock — assertions configure prisma.<model>.<method>.
vi.mock("@/lib/prisma", async () => {
  const { createPrismaMock } = await import("@/test/prisma-mock");
  return { prisma: createPrismaMock() };
});

import { prisma } from "@/lib/prisma";
import { createTRPCContext } from "@/server/trpc";
import { generateApiTokenSecret } from "@/server/services/api-tokens";
import { resetRateLimit } from "@/lib/rate-limit";
import { API_TOKEN_FAIL_RATE_LIMIT_BUCKET } from "@/server/services/api-tokens";
import type { PrismaMock } from "@/test/prisma-mock";

const prismaMock = prisma as unknown as PrismaMock;

const USER_ID = "cmuser000000000000000000u1";
const IP = "203.0.113.55";

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimit(API_TOKEN_FAIL_RATE_LIMIT_BUCKET, IP);
});

describe("createTRPCContext auth resolution", () => {
  it("passes a cookie session through untouched", async () => {
    const cookieSession = {
      user: { id: USER_ID, role: "member" as const },
      expires: "2026-12-01T00:00:00.000Z",
    };

    const ctx = await createTRPCContext({ headers: new Headers(), session: cookieSession });

    expect(ctx.session).toEqual(cookieSession);
    expect(prismaMock.apiToken.findMany).not.toHaveBeenCalled();
  });

  it("builds a token session from a valid bearer header when no cookie session exists", async () => {
    const generated = await generateApiTokenSecret();
    prismaMock.apiToken.findMany.mockResolvedValue([
      {
        id: "cmtok000000000000000000t2",
        userId: USER_ID,
        tokenHash: generated.tokenHash,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    prismaMock.user.findUnique.mockResolvedValue({ id: USER_ID, role: "member", disabledAt: null });

    const ctx = await createTRPCContext({
      headers: new Headers({
        authorization: `Bearer ${generated.token}`,
        "x-real-ip": IP,
      }),
      session: null,
    });

    expect(ctx.session).toEqual({
      user: { id: USER_ID, role: "member" },
      expires: "",
      authMethod: "token",
    });
  });

  it("returns a null session when neither cookie nor token authenticate", async () => {
    const ctx = await createTRPCContext({ headers: new Headers(), session: null });

    expect(ctx.session).toBeNull();
  });

  it("returns a null session for an invalid bearer header", async () => {
    const ctx = await createTRPCContext({
      headers: new Headers({
        authorization: `Bearer tk_${"n".repeat(43)}`,
        "x-real-ip": IP,
      }),
      session: null,
    });

    expect(ctx.session).toBeNull();
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });
});