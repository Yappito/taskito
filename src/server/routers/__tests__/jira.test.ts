import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "@/server/trpc";
import { memberOf } from "@/test/actors";
import { jiraRouter } from "../jira";
import { JiraClient } from "@/server/services/jira/client";
import { decryptSecret } from "@/lib/secret-crypto";
const PROJECT = "cmab8yxxp0001a0p0r0j0e0c0t0a0a0";
const OTHER = "cmab8yxxp0002b0p0r0j0e0c0t0b0b0";
const callerFactory = createCallerFactory(jiraRouter);
const setup = () => {
  const actor = memberOf({
    userId: "member",
    projects: { [PROJECT]: "member" },
  });
  actor.prisma.workflowStatus.findMany.mockResolvedValue([]);
  return {
    actor,
    caller: callerFactory({
      prisma: actor.prisma as never,
      session: { user: actor.sessionUser } as never,
    }),
  };
};
beforeEach(() =>
  vi.stubEnv("AI_SECRET_MASTER_KEY", Buffer.alloc(32, 7).toString("base64")),
);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("personal Jira connection authorization", () => {
  it("selects only the caller's connection and never selects its token", async () => {
    const { actor, caller } = setup();
    await caller.connection();
    const args = actor.prisma.jiraConnection.findUnique.mock.calls[0][0];
    expect(args.where).toEqual({ userId: "member" });
    expect(args.select.encryptedApiToken).toBeUndefined();
  });
  it("rejects importing into a project outside the caller's access before contacting Jira", async () => {
    const { caller } = setup();
    const request = vi.spyOn(JiraClient.prototype, "request");
    await expect(
      caller.save({
        projectId: OTHER,
        siteUrl: "https://team.atlassian.net",
        email: "person@example.com",
        apiToken: "token",
      }),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("verifies the account, discovers request participants, and encrypts the token under the rotation lock", async () => {
    const { actor, caller } = setup();
    vi.spyOn(JiraClient.prototype, "request").mockImplementation(
      async (path) =>
        path.endsWith("myself")
          ? { accountId: "atlassian-account" }
          : [
              {
                id: "customfield_123",
                name: "Participants",
                schema: {
                  custom: "com.atlassian.servicedesk:sd-request-participants",
                },
              },
            ],
    );
    await caller.save({
      projectId: PROJECT,
      siteUrl: "https://team.atlassian.net",
      email: "person@example.com",
      apiToken: "secret-token",
    });
    const args = actor.prisma.jiraConnection.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({
      userId: "member",
      accountId: "atlassian-account",
      participantFieldId: "customfield_123",
    });
    expect(args.create.encryptedApiToken).not.toBe("secret-token");
    expect(decryptSecret(args.create.encryptedApiToken)).toBe("secret-token");
    expect(args.create.apiToken).toBeUndefined();
    expect(actor.prisma.$queryRaw).toHaveBeenCalled();
  });
  it("does not allow switching the identity of an existing linked connection", async () => {
    const { actor, caller } = setup();
    actor.prisma.jiraConnection.findUnique.mockResolvedValue({
      id: "connection",
      siteUrl: "https://old.atlassian.net",
      email: "person@example.com",
      projectId: PROJECT,
    });
    actor.prisma.jiraIssue.count.mockResolvedValue(1);
    await expect(
      caller.save({
        projectId: PROJECT,
        siteUrl: "https://new.atlassian.net",
        email: "person@example.com",
        apiToken: "new-token",
      }),
    ).rejects.toThrow("Disconnect before changing");
    expect(actor.prisma.jiraConnection.upsert).not.toHaveBeenCalled();
  });
  it("disconnects only the caller's connection", async () => {
    const { actor, caller } = setup();
    await caller.disconnect();
    expect(actor.prisma.jiraConnection.deleteMany).toHaveBeenCalledWith({
      where: { userId: "member" },
    });
  });
});
