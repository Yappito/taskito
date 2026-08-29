import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// The export route binds the process-wide prisma singleton, so the module is
// replaced with a proxy mock — assertions configure prisma.<model>.<method>.
vi.mock("@/lib/prisma", async () => {
  const { createPrismaMock } = await import("@/test/prisma-mock");
  return { prisma: createPrismaMock() };
});

// Cookie sessions are mocked: tests control what `auth()` resolves to.
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/projects/[slug]/export/route";
import { generateApiTokenSecret } from "@/server/services/api-tokens";
import { resetRateLimit } from "@/lib/rate-limit";
import type { PrismaMock } from "@/test/prisma-mock";

const prismaMock = prisma as unknown as PrismaMock;
const authMock = auth as unknown as Mock;

const USER_ID = "cmuser000000000000000000u1";
const PROJECT_ID = "cmproj000000000000000000p1";
const PROJECT_SLUG = "alpha";
const IP = "203.0.113.70";

/** User shape returned when cookie/token resolution looks up the token owner. */
const tokenUser = { id: USER_ID, role: "member", disabledAt: null };

/**
 * User shape returned to getEffectiveProjectAccess (its select contains
 * projectMemberships). `isMember=false` yields no membership and therefore no
 * project permissions → the route's requireProjectAccess throws FORBIDDEN.
 */
function accessUser(isMember: boolean) {
  return {
    id: USER_ID,
    role: "member",
    disabledAt: null,
    projectMemberships: isMember ? [{ role: "member" }] : [],
    projectPermissionGrants: [],
    groupMemberships: [],
  };
}

function projectRecord() {
  return { id: PROJECT_ID, key: "ALPHA", name: "Alpha" };
}

function exportRequest(options: { authorization?: string; format?: "csv" | "json" } = {}) {
  const headers = new Headers({ "x-real-ip": IP });
  if (options.authorization) {
    headers.set("authorization", options.authorization);
  }
  const format = options.format ?? "csv";
  return new Request(`http://localhost:3000/api/projects/${PROJECT_SLUG}/export?format=${format}`, { headers });
}

function routeContext() {
  return { params: Promise.resolve({ slug: PROJECT_SLUG }) };
}

/**
 * Wires prisma mocks so `resolveBearerToken` validates `generated.token` and
 * access resolution depends on `isMember`.
 */
async function setupValidToken(isMember: boolean) {
  const generated = await generateApiTokenSecret();
  prismaMock.apiToken.findMany.mockResolvedValue([
    {
      id: "cmtok000000000000000000t1",
      userId: USER_ID,
      tokenHash: generated.tokenHash,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    },
  ]);
  prismaMock.user.findUnique.mockImplementation(async (args: {
    select?: Record<string, unknown>;
  }) => {
    if (args?.select?.projectMemberships !== undefined) {
      return accessUser(isMember);
    }
    return tokenUser;
  });
  return `Bearer ${generated.token}`;
}

function setupHappyPath() {
  prismaMock.project.findUnique.mockResolvedValue(projectRecord());
  prismaMock.customField.findMany.mockResolvedValue([]);
  prismaMock.workflowStatus.findMany.mockResolvedValue([]);
  prismaMock.tag.findMany.mockResolvedValue([]);
  prismaMock.user.findMany.mockResolvedValue([]);
  prismaMock.sprint.findMany.mockResolvedValue([]);
  prismaMock.task.findMany.mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetRateLimit("api-token:fail", IP);
  authMock.mockResolvedValue(null);
  // Unknown-token lookups see an empty prefix table by default.
  prismaMock.apiToken.findMany.mockResolvedValue([]);
});

describe("GET /api/projects/[slug]/export auth branches", () => {
  it("returns 401 with no cookie session and no Authorization header", async () => {
    const response = await GET(exportRequest(), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    // Token resolution never looks anything up without a header.
    expect(prismaMock.apiToken.findMany).not.toHaveBeenCalled();
  });

  it("returns 401 for a garbage bearer token with no cookie session", async () => {
    const response = await GET(exportRequest({ authorization: "Bearer not-a-taskito-token" }), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 401 for a well-formed token with no matching stored token", async () => {
    const response = await GET(exportRequest({ authorization: `Bearer ${"tk_".padEnd(46, "a")}` }), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
  });

  it("returns 200 for a valid token whose user is a project member", async () => {
    const authorization = await setupValidToken(true);
    setupHappyPath();

    const response = await GET(exportRequest({ authorization }), routeContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    const bytes = new Uint8Array(await response.arrayBuffer());
    // 200 path reached: the CSV stream ran (UTF-8 BOM + header row for zero tasks).
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
    const bodyWithoutBom = new TextDecoder().decode(bytes.slice(3));
    expect(bodyWithoutBom).toContain("Key,Title,Status");
    // Export was scoped to the queried project.
    expect(prismaMock.task.findMany).toHaveBeenCalled();
    const where = prismaMock.task.findMany.mock.calls[0]?.[0]?.where as {
      AND?: Array<{ projectId?: string }>;
    };
    expect(where.AND?.[0]?.projectId).toBe(PROJECT_ID);
  });

  it("returns 403 for a valid token whose user has no project access", async () => {
    const authorization = await setupValidToken(false);
    prismaMock.project.findUnique.mockResolvedValue(projectRecord());

    const response = await GET(exportRequest({ authorization }), routeContext());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    // Streaming never starts without task_read access.
    expect(prismaMock.task.findMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a valid token and an unknown project slug", async () => {
    const authorization = await setupValidToken(true);
    prismaMock.project.findUnique.mockResolvedValue(null);

    const response = await GET(exportRequest({ authorization }), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("keeps the cookie-session path working and skips token resolution", async () => {
    authMock.mockResolvedValue({ user: { id: USER_ID, role: "member" }, expires: "" });
    setupHappyPath();

    const response = await GET(exportRequest(), routeContext());

    expect(response.status).toBe(200);
    expect(prismaMock.apiToken.findMany).not.toHaveBeenCalled();
  });
});