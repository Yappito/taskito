import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TRPCError } from "@trpc/server";

import { requireGlobalAdmin } from "@/server/authz";
import { createPrismaMock, type PrismaMock } from "@/test/prisma-mock";

const ADMIN_ID = "cmadmin0000000000000000000a";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requireGlobalAdmin with bearer-token sessions", () => {
  it("rejects token-authenticated requests even when the user is an admin (v1: tokens never grant admin)", async () => {
    const prisma: PrismaMock = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: ADMIN_ID, role: "admin", disabledAt: null });

    await expect(
      requireGlobalAdmin(prisma as never, ADMIN_ID, { authMethod: "token" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" satisfies TRPCError["code"] });

    // The rejection short-circuits before any user lookup happens.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("still allows admin users with cookie sessions", async () => {
    const prisma: PrismaMock = createPrismaMock();
    prisma.user.findUnique.mockResolvedValue({ id: ADMIN_ID, role: "admin", disabledAt: null });

    await expect(requireGlobalAdmin(prisma as never, ADMIN_ID)).resolves.toMatchObject({
      id: ADMIN_ID,
      role: "admin",
    });
  });
});