import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createPrismaMock } from "@/test/prisma-mock";
import { encryptSecret } from "@/lib/secret-crypto";
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  taskAccess: vi.fn(),
  lock: vi.fn(),
  end: vi.fn(),
  readAttachment: vi.fn(),
}));
vi.mock("@/server/authz", () => ({
  requireProjectAccess: mocks.access,
  requireTaskAccess: mocks.taskAccess,
}));
vi.mock("@/lib/prisma", async () => ({
  prisma: (await import("@/test/prisma-mock")).createPrismaMock(),
}));
vi.mock("@/server/routers/task", () => ({ createTaskWithNextNumber: vi.fn() }));
vi.mock("@/server/services/scheduler-lock-connection", () => ({
  createSchedulerLockConnection: () => ({
    runExclusive: mocks.lock,
    end: mocks.end,
  }),
}));
vi.mock("@/server/services/comment-attachments", () => ({
  readStoredCommentAttachment: mocks.readAttachment,
  storeCommentAttachment: vi.fn(),
  removeStoredCommentAttachments: vi.fn(),
}));
import { prisma } from "@/lib/prisma";
import {
  deliverJiraComment,
  deliverJiraFields,
  exportJiraTask,
  prepareJiraComment,
  syncJiraConnection,
} from "../sync";
import { JiraClient } from "../client";
const db = prisma as unknown as ReturnType<typeof createPrismaMock>;
let connection: Record<string, unknown>;
let link: Record<string, unknown>;
let comment: Record<string, unknown>;
let request: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AI_SECRET_MASTER_KEY", Buffer.alloc(32, 7).toString("base64"));
  connection = {
    id: "connection",
    userId: "user",
    accountId: "account",
    projectId: "project",
    siteUrl: "https://team.atlassian.net",
    email: "me@example.com",
    encryptedApiToken: encryptSecret("token"),
    enabled: true,
    intervalMinutes: 5,
  };
  link = {
    id: "link",
    taskId: "task",
    connectionId: "connection",
    siteUrl: connection.siteUrl,
    issueId: "100",
    issueKey: "HELP-1",
    serviceDeskId: "1",
    syncState: "synced",
    connection,
    outboundVersion: 1,
    sentVersion: 0,
    outboundStatus: true,
    outboundFields: ["title", "body"],
    task: {
      id: "task",
      projectId: "project",
      title: "Title",
      body: "Description",
      dueDate: new Date("2026-09-18"),
      status: { name: "Done" },
    },
  };
  comment = {
    id: "comment",
    taskId: "task",
    authorId: "user",
    content: "Internal note",
    visibility: "internal",
    jiraSyncState: "pending",
    attachments: [],
    task: { projectId: "project", jiraIssue: link },
  };
  db.jiraConnection.findUnique.mockResolvedValue(connection);
  db.jiraConnection.findUniqueOrThrow.mockResolvedValue(connection);
  db.jiraIssue.findUnique.mockImplementation(async () => link);
  db.comment.findUnique.mockImplementation(async () => comment);
  db.comment.findUniqueOrThrow.mockImplementation(async () => comment);
  db.comment.update.mockImplementation(async ({ data }) => {
    Object.assign(comment, data);
    return comment;
  });
  db.jiraIssue.update.mockImplementation(async ({ data }) => {
    Object.assign(link, data);
    return link;
  });
  mocks.access.mockResolvedValue({});
  mocks.taskAccess.mockResolvedValue({ projectId: "project" });
  mocks.lock.mockImplementation(async (_key, callback) => callback());
  mocks.readAttachment.mockResolvedValue(new Uint8Array([1, 2, 3]));
  request = vi
    .spyOn(JiraClient.prototype, "request")
    .mockResolvedValue({ id: "remote-comment" });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Jira delivery safety", () => {
  it("sends internal comments through JSM with public=false and deduplicates subsequent delivery", async () => {
    await deliverJiraComment("comment");
    expect(request).toHaveBeenCalledWith(
      "/rest/servicedeskapi/request/HELP-1/comment",
      expect.objectContaining({
        body: JSON.stringify({ body: "Internal note", public: false }),
      }),
    );
    expect(comment).toMatchObject({
      jiraSyncState: "synced",
      jiraCommentId: "remote-comment",
    });
    await deliverJiraComment("comment");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("sends attachments and the internal comment in the same JSM visibility operation", async () => {
    comment.attachments = [{ id: "file", originalName: "private.txt" }];
    vi.spyOn(JiraClient.prototype, "upload").mockResolvedValue({
      temporaryAttachments: [{ temporaryAttachmentId: "temp" }],
    });
    request.mockResolvedValue({
      comment: { id: "remote-comment" },
      attachments: { values: [{ id: "attachment" }] },
    });
    await deliverJiraComment("comment");
    expect(request).toHaveBeenCalledWith(
      "/rest/servicedeskapi/request/HELP-1/attachment",
      expect.objectContaining({
        body: JSON.stringify({
          public: false,
          additionalComment: { body: "Internal note" },
          temporaryAttachmentIds: ["temp"],
        }),
      }),
    );
    expect(db.commentAttachment.update).toHaveBeenCalledWith({
      where: { id: "file" },
      data: { jiraAttachmentId: "attachment" },
    });
  });
  it("never retries an ambiguous non-idempotent comment write automatically", async () => {
    request.mockRejectedValue(new TypeError("fetch failed"));
    await deliverJiraComment("comment");
    expect(comment.jiraSyncState).toBe("uncertain");
    await deliverJiraComment("comment");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("blocks internal comments on standard Jira before persisting or sending them", async () => {
    link.serviceDeskId = null;
    await expect(
      prepareJiraComment("user", "task", "internal"),
    ).rejects.toThrow("Internal Jira comments require");
    expect(request).not.toHaveBeenCalled();
  });
  it("rechecks the author's permissions before sending pending work", async () => {
    mocks.access.mockRejectedValue(new Error("No project access"));
    await deliverJiraComment("comment");
    expect(request).not.toHaveBeenCalled();
    expect(comment.jiraSyncState).toBe("failed");
  });
  it("skips a claimed task when another replica holds the lock", async () => {
    mocks.lock.mockResolvedValue(null);
    await deliverJiraComment("comment");
    expect(request).not.toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalled();
  });
  it("retains pending status changes when Jira has no matching transition", async () => {
    request.mockImplementation(async (path: string) =>
      path.endsWith("/transitions")
        ? { transitions: [] }
        : path.includes("fields=status")
          ? { fields: { status: { name: "Open" } } }
          : undefined,
    );
    await deliverJiraFields("task");
    expect(link).toMatchObject({ sentVersion: 0, syncState: "failed" });
    expect(link.lastError).toContain("No unique Jira transition");
  });
  it("uses a live matching transition and acknowledges only the captured version", async () => {
    request.mockImplementation(async (path: string, init?: RequestInit) =>
      path.endsWith("/transitions") && !init
        ? { transitions: [{ id: "31", to: { name: "Done" } }] }
        : path.includes("fields=status")
          ? { fields: { status: { name: "Open" } } }
          : undefined,
    );
    await deliverJiraFields("task");
    expect(request).toHaveBeenCalledWith(
      "/rest/api/3/issue/HELP-1/transitions",
      { method: "POST", body: JSON.stringify({ transition: { id: "31" } }) },
    );
    expect(link.sentVersion).toBe(1);
    expect(db.jiraIssue.updateMany).toHaveBeenCalledWith({
      where: { id: "link", outboundVersion: 1 },
      data: { outboundStatus: false, outboundFields: [] },
    });
  });
  it("creates a service request using the chosen request type", async () => {
    Object.assign(link, {
      issueId: null,
      issueKey: null,
      requestTypeId: "42",
      syncState: "pending",
    });
    request.mockResolvedValue({ issueId: "200", issueKey: "HELP-2" });
    await exportJiraTask("task");
    expect(request).toHaveBeenCalledWith(
      "/rest/servicedeskapi/request",
      expect.objectContaining({
        body: JSON.stringify({
          serviceDeskId: "1",
          requestTypeId: "42",
          requestFieldValues: { summary: "Title", description: "Description" },
        }),
      }),
    );
    expect(link.issueKey).toBe("HELP-2");
  });
  it("leaves interrupted issue creation for review instead of creating a second issue", async () => {
    Object.assign(link, { issueId: null, syncState: "pending" });
    request.mockRejectedValue(new TypeError("fetch failed"));
    await exportJiraTask("task");
    await exportJiraTask("task");
    expect(link.syncState).toBe("uncertain");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("continues pulling linked resolved tickets that no longer match discovery", async () => {
    db.jiraIssue.findMany.mockResolvedValue([{ ...link, outboundVersion: 0 }]);
    db.comment.findMany.mockResolvedValue([]);
    vi.spyOn(JiraClient.prototype, "search").mockImplementation(
      async function* () {},
    );
    request.mockRejectedValue(new Error("fixture stops after fetch"));
    await syncJiraConnection("connection");
    expect(request).toHaveBeenCalledWith("/rest/api/3/issue/100");
    expect(db.jiraConnection.update).toHaveBeenCalled();
  });
});

describe("Jira imports", () => {
  it.each([false, true])(
    "imports comments and history even with an oversized attachment: %s",
    async (oversized) => {
      Object.assign(link, { outboundVersion: 0, sentVersion: 0 });
      const remote = {
        id: "100",
        key: "HELP-1",
        fields: {
          summary: "From Jira",
          description: "Remote description",
          created: "2026-01-01T00:00:00Z",
          updated: "2026-09-18T08:00:00Z",
          project: {
            key: "HELP",
            name: "Help desk",
            projectTypeKey: "service_desk",
          },
          status: { name: "Open", statusCategory: { key: "new" } },
          assignee: { accountId: "account" },
        },
      };
      db.jiraIssue.findMany.mockResolvedValue([link]);
      db.jiraIssue.findUniqueOrThrow.mockResolvedValue(link);
      db.workflowStatus.findMany.mockResolvedValue([
        { id: "todo", name: "Open", category: "todo", isFinal: false },
      ]);
      db.task.findUniqueOrThrow.mockResolvedValue({
        id: "task",
        projectId: "project",
        updatedAt: new Date("2026-09-18"),
      });
      db.tag.upsert.mockResolvedValue({ id: "source-tag" });
      db.comment.findUnique.mockResolvedValue(null);
      db.comment.upsert.mockImplementation(async ({ create }) => ({
        id: `local-${create.jiraCommentId}`,
        ...create,
      }));
      db.comment.findMany.mockResolvedValue([]);
      vi.spyOn(JiraClient.prototype, "search").mockImplementation(
        async function* () {
          yield remote;
        },
      );
      request.mockImplementation(async (path: string) =>
        path.startsWith("/rest/servicedeskapi/request/")
          ? { serviceDeskId: "1" }
          : remote,
      );
      const history = [
        {
          id: "history-1",
          created: "2026-09-18T07:00:00Z",
          author: { displayName: "Agent" },
          items: [{ field: "status", fromString: "New", toString: "Open" }],
        },
      ];
      vi.spyOn(JiraClient.prototype, "pages").mockImplementation(
        async (path: string) =>
          path.endsWith("/changelog")
            ? history
            : path.endsWith("/comment")
              ? [
                  {
                    id: "public",
                    body: "Customer reply",
                    public: true,
                    author: { displayName: "Customer" },
                    created: { iso8601: "2026-09-17T00:00:00Z" },
                  },
                  {
                    id: "internal",
                    body: "Agent note",
                    public: false,
                    author: { displayName: "Agent" },
                  },
                ]
              : oversized && path.includes("/comment/public/attachment")
                ? [
                    {
                      id: "big",
                      filename: "too-large.zip",
                      mimeType: "application/zip",
                      size: 21 * 1024 * 1024,
                    },
                  ]
                : [],
      );
      const result = await syncJiraConnection("connection");
      expect(result).toMatchObject({
        imported: oversized ? 0 : 1,
        errors: oversized ? 1 : 0,
      });
      expect(db.comment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            visibility: "public",
            externalAuthor: "Customer",
            createdAt: new Date("2026-09-17T00:00:00Z"),
            jiraSyncState: "synced",
          }),
        }),
      );
      expect(db.comment.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            visibility: "internal",
            externalAuthor: "Agent",
          }),
        }),
      );
      expect(db.jiraIssue.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ history }) }),
      );
      expect(db.tag.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ name: "Jira: HELP" }),
        }),
      );
      expect(
        request.mock.calls.every(
          ([, init]: [unknown, RequestInit?]) =>
            !init?.method || init.method === "GET",
        ),
      ).toBe(true);
    },
  );
  it("does not import remote fields over a pending local edit", async () => {
    const remote = {
      id: "100",
      key: "HELP-1",
      fields: {
        summary: "Stale remote",
        created: "2026-01-01T00:00:00Z",
        updated: "2026-09-18T08:00:00Z",
        project: { key: "HELP", name: "Help", projectTypeKey: "software" },
        status: { name: "Open", statusCategory: { key: "new" } },
      },
    };
    // Export is intentionally omitted from the sweep snapshot: another local
    // edit arrives after it was collected and is observed inside import.
    db.jiraIssue.findMany.mockResolvedValue([]);
    db.jiraIssue.findUniqueOrThrow.mockResolvedValue(link);
    db.workflowStatus.findMany.mockResolvedValue([
      { id: "todo", name: "Open", category: "todo", isFinal: false },
    ]);
    db.task.findUniqueOrThrow.mockResolvedValue({
      id: "task",
      projectId: "project",
      updatedAt: new Date(),
    });
    db.tag.upsert.mockResolvedValue({ id: "tag" });
    db.comment.findMany.mockResolvedValue([]);
    vi.spyOn(JiraClient.prototype, "search").mockImplementation(
      async function* () {
        yield remote;
      },
    );
    request.mockResolvedValue(remote);
    vi.spyOn(JiraClient.prototype, "pages").mockResolvedValue([]);
    await syncJiraConnection("connection");
    expect(db.task.updateMany).not.toHaveBeenCalled();
  });
});
