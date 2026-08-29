import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAccessibleProjectIds, isEmailConfigured, sendEmail, prismaRef } = vi.hoisted(() => ({
  getAccessibleProjectIds: vi.fn(),
  isEmailConfigured: vi.fn(),
  sendEmail: vi.fn(),
  prismaRef: { current: {} as unknown },
}));

vi.mock("@/server/authz", () => ({
  getAccessibleProjectIds,
}));

vi.mock("@/server/services/email/smtp-client", () => ({
  isEmailConfigured,
  sendEmail,
  logEmailError: vi.fn(),
}));

vi.mock("@/server/services/notifications", () => ({
  readEmailChannelPreference: (settings: unknown, key: string) => {
    const emailChannel =
      ((settings as { emailChannel?: Record<string, unknown> } | null)?.emailChannel ?? {}) as Record<string, unknown>;
    return emailChannel[key] === true;
  },
}));

vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return prismaRef.current;
  },
}));

import {
  buildDueSoonDigest,
  resetDailyDigestJobForTests,
  runDailyDigestJob,
  sendDueSoonDigests,
} from "../digest";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-29T10:30:00.000Z");
const DAY_START = Date.UTC(2026, 7, 29);

function isoDay(offsetDays: number) {
  return new Date(DAY_START + offsetDays * DAY_MS);
}

function taskRow(overrides: Record<string, unknown>) {
  return {
    id: "t",
    title: "Title",
    taskNumber: 5,
    dueDate: NOW,
    projectId: "p1",
    project: { key: "PROJ", name: "Project", slug: "project" },
    ...overrides,
  };
}

const projectP1 = { id: "p1", settings: { dueDateWarningDays: 3 } };

/** Prisma mock mirroring the surfaces digest.ts touches. */
function makePrisma(options: {
  user?: { id: string; name: string | null; email: string; settings: unknown } | null;
  users?: Array<{ id: string; name: string | null; email: string; settings: unknown }>;
  userById?: Record<string, { id: string; name: string | null; email: string; settings: unknown } | null>;
  projects?: Array<{ id: string; settings: unknown }>;
  statuses?: Array<{ id: string; category: string }>;
  taskCalls?: Array<Array<Record<string, unknown>>>;
}) {
  let taskCallIndex = 0;
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        if (options.userById) return options.userById[where.id] ?? null;
        return options.user ?? null;
      }),
      findMany: vi.fn(async () => options.users ?? []),
      update: vi.fn(async () => ({})),
    },
    project: { findMany: vi.fn(async () => options.projects ?? []) },
    workflowStatus: {
      findMany: vi.fn(async () => options.statuses ?? [{ id: "s1", category: "todo" }]),
    },
    task: {
      findMany: vi.fn(async () => options.taskCalls?.[taskCallIndex++] ?? []),
    },
  };
}

describe("buildDueSoonDigest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAccessibleProjectIds.mockResolvedValue(["p1"]);
  });

  it("groups overdue, due-today, due-soon and blocked tasks", async () => {
    const prisma = makePrisma({
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [
        [
          taskRow({ id: "t-overdue", dueDate: isoDay(-2), title: "Overdue task" }),
          taskRow({ id: "t-today", dueDate: new Date(DAY_START + 2 * 3600_000), title: "Today task" }),
          taskRow({ id: "t-soon", dueDate: isoDay(2), title: "Soon task" }),
          taskRow({ id: "t-far", dueDate: isoDay(30), title: "Far task" }),
        ],
        [
          taskRow({ id: "t-blocked", assigneeId: "u1", dueDate: isoDay(10), title: "Blocked task" }),
          taskRow({ id: "t-overdue", title: "Already reported" }),
        ],
      ],
    });

    const digest = await buildDueSoonDigest(prisma as never, "u1", NOW);

    expect(digest).not.toBeNull();
    expect(digest?.overdue.map((task) => task.taskId)).toEqual(["t-overdue"]);
    expect(digest?.dueToday.map((task) => task.taskId)).toEqual(["t-today"]);
    expect(digest?.dueSoon.map((task) => task.taskId)).toEqual(["t-soon"]);
    // "Far task" sits outside even the query's widest window filter.
    expect(digest?.dueSoon.map((task) => task.title)).not.toContain("Far task");
    // Blocked bucket excludes tasks already reported in the due buckets.
    expect(digest?.blockedOn.map((task) => task.taskId)).toEqual(["t-blocked"]);
    expect(digest?.overdue[0]).toMatchObject({ key: "PROJ-5", projectName: "Project", projectSlug: "project" });
  });

  it("widens the due-soon window with the project's dueDateWarningDays", async () => {
    const prisma = makePrisma({
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [{ id: "p1", settings: { dueDateWarningDays: 7 } }],
      taskCalls: [[taskRow({ id: "t6", dueDate: isoDay(6), title: "Six days out" })], []],
    });

    const digest = await buildDueSoonDigest(prisma as never, "u1", NOW);
    expect(digest?.dueSoon.map((task) => task.taskId)).toEqual(["t6"]);
  });

  it("returns null when the user has nothing to report", async () => {
    const prisma = makePrisma({
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[], []],
    });

    expect(await buildDueSoonDigest(prisma as never, "u1", NOW)).toBeNull();
  });

  it("returns null without an email address", async () => {
    const prisma = makePrisma({
      user: { id: "u1", name: null, email: "", settings: {} },
      projects: [projectP1],
    });
    expect(await buildDueSoonDigest(prisma as never, "u1", NOW)).toBeNull();
  });

  it("returns null when the user has no accessible projects", async () => {
    getAccessibleProjectIds.mockResolvedValue([]);
    const prisma = makePrisma({
      user: { id: "u1", name: null, email: "a@b.c", settings: {} },
      projects: [],
    });
    expect(await buildDueSoonDigest(prisma as never, "u1", NOW)).toBeNull();
  });
});

describe("sendDueSoonDigests", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    isEmailConfigured.mockReturnValue(true);
    sendEmail.mockResolvedValue(undefined);
  });

  it("sends only to users with the digest preference on and skips empty digests", async () => {
    const prisma = makePrisma({
      users: [
        { id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } },
        { id: "u2", name: "Bob", email: "bob@example.com", settings: { emailChannel: { digest: false } } },
        { id: "u3", name: "Cy", email: "cy@example.com", settings: { emailChannel: { digest: true } } },
      ],
      userById: {
        u1: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
        u3: { id: "u3", name: "Cy", email: "cy@example.com", settings: {} },
      },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1), title: "Overdue thing" })], []],
    });
    getAccessibleProjectIds.mockResolvedValueOnce(["p1"]); // u1 has content
    getAccessibleProjectIds.mockResolvedValueOnce([]); // u3 has nothing to report

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 1, skipped: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        subject: expect.stringContaining("digest"),
      })
    );
  });

  it("skips users whose lastDigestSentAt already falls within the current UTC day", async () => {
    const prisma = makePrisma({
      users: [
        {
          id: "u1",
          name: "Ada",
          email: "ada@example.com",
          settings: { emailChannel: { digest: true, lastDigestSentAt: NOW.toISOString() } },
        },
      ],
      // Full data set: without the DB-backed guard the user would be sent a
      // second digest for the same day.
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1), title: "Overdue thing" })], []],
    });
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 0, skipped: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("sends again when lastDigestSentAt is from an earlier UTC day", async () => {
    const prisma = makePrisma({
      users: [
        {
          id: "u1",
          name: "Ada",
          email: "ada@example.com",
          settings: { emailChannel: { digest: true, lastDigestSentAt: isoDay(-1).toISOString() } },
        },
      ],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1), title: "Overdue thing" })], []],
    });
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("records emailChannel.lastDigestSentAt in User.settings after sending", async () => {
    const prisma = makePrisma({
      users: [
        {
          id: "u1",
          name: "Ada",
          email: "ada@example.com",
          settings: {
            notificationPreferences: { assignments: true },
            emailChannel: { digest: true },
          },
        },
      ],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1), title: "Overdue thing" })], []],
    });
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        settings: expect.objectContaining({
          // Unrelated settings keys survive the write.
          notificationPreferences: { assignments: true },
          emailChannel: { digest: true, lastDigestSentAt: NOW.toISOString() },
        }),
      },
    });
  });

  it("still counts the send when the lastDigestSentAt bookkeeping fails", async () => {
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1) })], []],
    });
    prisma.user.update.mockRejectedValueOnce(new Error("db down"));
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 1, skipped: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when SMTP is unconfigured", async () => {
    isEmailConfigured.mockReturnValue(false);
    const prisma = makePrisma({});
    const result = await sendDueSoonDigests(NOW, prisma as never);
    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("runDailyDigestJob", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetDailyDigestJobForTests();
    isEmailConfigured.mockReturnValue(true);
    sendEmail.mockResolvedValue(undefined);
    getAccessibleProjectIds.mockResolvedValue(["p1"]);
  });

  it("runs once per UTC day; a second call the same day is skipped", async () => {
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1), title: "Overdue thing" })], []],
    });
    prismaRef.current = prisma as never;

    const first = await runDailyDigestJob(NOW);
    expect(first).toEqual({ sent: 1, skipped: 0 });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: {
        settings: expect.objectContaining({
          emailChannel: expect.objectContaining({ lastDigestSentAt: NOW.toISOString() }),
        }),
      },
    });

    const second = await runDailyDigestJob(new Date(NOW.getTime() + 3600_000));
    expect(second).toEqual({ skipped: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("can run again on the next UTC day after a guard reset", async () => {
    prismaRef.current = makePrisma({}) as never;
    await runDailyDigestJob(NOW);
    prismaRef.current = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1) })], []],
    }) as never;
    resetDailyDigestJobForTests();
    const nextDay = await runDailyDigestJob(new Date(NOW.getTime() + DAY_MS));
    expect(nextDay).toEqual({ sent: 1, skipped: 0 });
  });

  it("does nothing when email is not configured", async () => {
    isEmailConfigured.mockReturnValue(false);
    prismaRef.current = makePrisma({}) as never;
    const result = await runDailyDigestJob(NOW);
    expect(result).toEqual({ sent: 0, skipped: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});