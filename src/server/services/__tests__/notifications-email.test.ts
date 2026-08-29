import { beforeEach, describe, expect, it, vi } from "vitest";

const { isEmailConfigured, queueEmail } = vi.hoisted(() => ({
  isEmailConfigured: vi.fn(),
  queueEmail: vi.fn(),
}));

vi.mock("@/server/services/email/smtp-client", () => ({
  isEmailConfigured,
  queueEmail,
}));

const prismaMock = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  task: { findUnique: vi.fn() },
  notification: { create: vi.fn() },
  taskWatcher: { findMany: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: prismaMock,
}));

import {
  createNotification,
  dispatchNotification,
  notifyTaskWatchers,
  readEmailChannelPreference,
} from "../notifications";

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

const taskDetails = {
  "task-1": {
    id: "task-1",
    title: "Ship the thing",
    taskNumber: 7,
    project: { key: "PROJ", name: "Project", slug: "project" },
  },
};

function userFound(id: string, settings: unknown, email = "ada@example.com") {
  return {
    where: { id },
    select: {},
    result: { id, name: "Recipient", email, settings },
  };
}

describe("notification email dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isEmailConfigured.mockReturnValue(true);
    queueEmail.mockReturnValue("queued");
    prismaMock.task.findUnique.mockResolvedValue(taskDetails["task-1"]);
  });

  it("emails when the recipient enabled the email channel for the type and is not the actor", async () => {
    const found = userFound("user-2", { emailChannel: { comments: true } });
    prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "user-2" ? found.result : { id: where.id, name: "Actor", email: "actor@example.com", settings: {} }
    );
    prismaMock.notification.create.mockResolvedValue({ id: "n1" });

    const notification = await dispatchNotification({
      recipientId: "user-2",
      actorId: "user-1",
      taskId: "task-1",
      type: "commented",
      payload: { commentId: "c1" },
    });
    await flushAsync();

    expect(notification).toEqual({ id: "n1" });
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(queueEmail).toHaveBeenCalledTimes(1);
    expect(queueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        subject: expect.stringContaining("PROJ-7"),
      })
    );
  });

  it("does not email when the email channel pref is off (default for comments)", async () => {
    const found = userFound("user-2", {});
    prismaMock.user.findUnique.mockResolvedValue(found.result);

    await dispatchNotification({
      recipientId: "user-2",
      actorId: "user-1",
      taskId: "task-1",
      type: "commented",
      payload: {},
    });
    await flushAsync();

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it("never emails the actor about their own action (recipient == actor)", async () => {
    const found = userFound("user-1", { emailChannel: { comments: true } });
    prismaMock.user.findUnique.mockResolvedValue(found.result);

    await dispatchNotification({
      recipientId: "user-1",
      actorId: "user-1",
      taskId: "task-1",
      type: "commented",
      payload: {},
    });
    await flushAsync();
    await flushAsync();

    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(queueEmail).not.toHaveBeenCalled();
  });

  it("does not throw when SMTP is unconfigured", async () => {
    isEmailConfigured.mockReturnValue(false);
    prismaMock.user.findUnique.mockResolvedValue(userFound("user-2", {}).result);

    await expect(
      dispatchNotification({
        recipientId: "user-2",
        actorId: "user-1",
        taskId: "task-1",
        type: "mentioned",
        payload: {},
      })
    ).resolves.toBeDefined();
    await flushAsync();
    expect(queueEmail).not.toHaveBeenCalled();
    // Only the in-app pathway touched prisma; no email-grade lookups happened.
    expect(prismaMock.user.findUnique).toHaveBeenCalledTimes(1);
  });

  it("keeps the in-app row gated by the existing in-app preferences", async () => {
    prismaMock.user.findUnique.mockResolvedValue(
      userFound("user-2", { notificationPreferences: { comments: false } }).result
    );

    const result = await createNotification({
      recipientId: "user-2",
      actorId: "user-1",
      taskId: "task-1",
      type: "commented",
      payload: {},
    });

    expect(result).toBeNull();
    expect(prismaMock.notification.create).not.toHaveBeenCalled();
  });

  it("notifyTaskWatchers emails watchers (except the actor) through dispatch", async () => {
    prismaMock.taskWatcher.findMany.mockResolvedValue([{ userId: "user-1" }, { userId: "user-2" }]);
    prismaMock.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "user-2"
        ? userFound("user-2", { emailChannel: { statusChanges: true } }).result
        : { id: where.id, name: "X", email: "x@example.com", settings: {} }
    );
    prismaMock.notification.create.mockResolvedValue({ id: "n" });

    await notifyTaskWatchers({
      taskId: "task-1",
      actorId: "user-1",
      type: "statusChanged",
      payload: { toStatusId: "s2" },
    });
    await flushAsync();

    expect(queueEmail).toHaveBeenCalledTimes(1);
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientId: "user-2", type: "statusChanged" }),
    });
  });
});

describe("readEmailChannelPreference defaults", () => {
  it("defaults mentioned + assigned to on, everything else off", () => {
    expect(readEmailChannelPreference({}, "mentions")).toBe(true);
    expect(readEmailChannelPreference({}, "assignments")).toBe(true);
    expect(readEmailChannelPreference({}, "comments")).toBe(false);
    expect(readEmailChannelPreference({}, "statusChanges")).toBe(false);
    expect(readEmailChannelPreference({}, "digest")).toBe(false);
  });

  it("explicit values win over defaults", () => {
    expect(readEmailChannelPreference({ emailChannel: { comments: true } }, "comments")).toBe(true);
    expect(readEmailChannelPreference({ emailChannel: { mentions: false } }, "mentions")).toBe(false);
    expect(readEmailChannelPreference(null, "digest")).toBe(false);
  });
});