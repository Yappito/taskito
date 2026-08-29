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

import { Prisma } from "@prisma/client";

import {
  buildDueSoonDigest,
  DIGEST_CLAIM_MAX_ATTEMPTS,
  resetDailyDigestJobForTests,
  runDailyDigestJob,
  sendDueSoonDigests,
} from "../digest";
import { DIGEST_MAX_TASKS_PER_SECTION } from "../templates";

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
  claims?: Array<{ userId: string; status: string; attempts: number; updatedAt: Date }>;
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
    emailDigestClaim: {
      // Called twice per run: the recipient claim preload (full claim rows),
      // then the retryable sweep (id-only select). The two shapes differ, so
      // the return type is widened; tests queue mockResolvedValueOnce(...)
      // values when the sweep result must differ from the preload.
      findMany: vi.fn(async (): Promise<Array<Record<string, unknown>>> => options.claims ?? []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "claim-1",
        ...data,
      })),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
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

  it("caps each collected digest bucket and retains a +N-more count for rendering", async () => {
    const overdueRows = Array.from({ length: DIGEST_MAX_TASKS_PER_SECTION + 25 }, (_, index) =>
      taskRow({ id: `overdue-${index}`, taskNumber: index + 1, dueDate: isoDay(-1) })
    );
    const prisma = makePrisma({
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [overdueRows, []],
    });

    const digest = await buildDueSoonDigest(prisma as never, "u1", NOW);

    expect(digest?.overdue).toHaveLength(DIGEST_MAX_TASKS_PER_SECTION);
    expect(digest?.overdueMore).toBe(25);
    expect(digest?.dueToday).toHaveLength(0);
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

    expect(result).toEqual({ sent: 1, skipped: 1, retryable: 0 });
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

    expect(result).toEqual({ sent: 0, skipped: 1, retryable: 0 });
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

    expect(result).toEqual({ sent: 1, skipped: 0, retryable: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("creates a durable pending claim, flips it to sending before SMTP, and closes it as succeeded", async () => {
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1) })], []],
    });
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    await sendDueSoonDigests(NOW, prisma as never);

    // The claim row is created BEFORE the send — the uniqueness boundary —
    // as pending: everything before SMTP is retry-safe.
    expect(prisma.emailDigestClaim.create).toHaveBeenCalledWith({
      data: { userId: "u1", dayUtc: "2026-08-29", status: "pending", attempts: 1 },
    });
    // CITADEL-e10 (finding 6): immediately before the SMTP call the claim
    // enters the ambiguous "sending" state.
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", dayUtc: "2026-08-29", status: "pending" },
      data: { status: "sending" },
    });
    // …and durably closed out once SMTP accepted the message.
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", dayUtc: "2026-08-29" },
      data: { status: "succeeded", sentAt: NOW },
    });
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

    expect(result).toEqual({ sent: 1, skipped: 0, retryable: 0 });
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

  it("does not resend from another replica when the settings bookkeeping fails after SMTP success", async () => {
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1) })], []],
    });
    // Legacy settings bookkeeping fails AFTER SMTP accepted the message.
    prisma.user.update.mockRejectedValueOnce(new Error("db down"));
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const first = await sendDueSoonDigests(NOW, prisma as never);

    expect(first).toEqual({ sent: 1, skipped: 0, retryable: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The durable claim — not lastDigestSentAt — was still closed as succeeded.
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", dayUtc: "2026-08-29" },
      data: { status: "succeeded", sentAt: NOW },
    });

    // Another replica re-running the same day reads the succeeded claim and
    // must NOT resend, even though the settings write above failed.
    const replicaClaims = [{ userId: "u1", status: "succeeded", attempts: 1, updatedAt: NOW }];
    const replica = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      claims: replicaClaims,
    });
    replica.emailDigestClaim.findMany
      .mockResolvedValueOnce(replicaClaims) // claim preload
      .mockResolvedValueOnce([]); // retryable sweep

    const second = await sendDueSoonDigests(NOW, replica as never);

    expect(second).toEqual({ sent: 0, skipped: 1, retryable: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  // CITADEL-e10 (finding 6): SMTP is an external side effect a DB row cannot
  // prove. If the durable succeeded-finalize write fails after SMTP accepted,
  // the claim is stuck in "sending" — AMBIGUOUS. The chosen semantics are
  // at-most-once: the next sweep must abandon the stale sending claim (failed
  // at the attempt cap) instead of resending.
  it("does not resend when the durable claim finalize fails after SMTP success — the stale sending claim is abandoned", async () => {
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1) })], []],
    });
    getAccessibleProjectIds.mockResolvedValue(["p1"]);
    // The durable claim finalize fails AFTER SMTP accepted the message.
    prisma.emailDigestClaim.updateMany
      .mockResolvedValueOnce({ count: 1 }) // pending → sending flip
      .mockRejectedValueOnce(new Error("db down")); // succeeded finalize

    const first = await sendDueSoonDigests(NOW, prisma as never);

    expect(first).toEqual({ sent: 1, skipped: 0, retryable: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The claim is now stuck in "sending" — ambiguous.
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", dayUtc: "2026-08-29", status: "pending" },
      data: { status: "sending" },
    });

    // A later run the SAME day (past the stale window) finds the stale
    // "sending" claim. It must NOT resend: at-most-once for the ambiguous
    // case — the claim is abandoned (failed at the attempt cap) with a
    // logged warning instead.
    const staleSending = { userId: "u1", status: "sending", attempts: 1, updatedAt: new Date(NOW.getTime() - 1000) };
    const later = new Date(NOW.getTime() + 3600_000);
    prisma.emailDigestClaim.updateMany.mockReset();
    prisma.emailDigestClaim.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailDigestClaim.findMany
      .mockResolvedValueOnce([staleSending]) // claim preload
      .mockResolvedValueOnce([]); // retryable sweep: the abandoned claim is terminal

    const second = await sendDueSoonDigests(later, prisma as never);

    expect(second).toEqual({ sent: 0, skipped: 1, retryable: 0 });
    // Still exactly one send for this user/day — no duplicate digest.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", dayUtc: "2026-08-29", status: "sending" },
      data: {
        status: "failed",
        attempts: DIGEST_CLAIM_MAX_ATTEMPTS,
        lastError: expect.stringContaining("abandoned"),
      },
    });
  });

  it("skips a recipient whose fresh sending claim is owned by another replica", async () => {
    const sendingClaim = { userId: "u1", status: "sending", attempts: 1, updatedAt: NOW };
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      claims: [sendingClaim],
    });
    prisma.emailDigestClaim.findMany
      .mockResolvedValueOnce([sendingClaim]) // claim preload
      .mockResolvedValueOnce([sendingClaim]); // retryable sweep: mid-flight elsewhere keeps the day open

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 0, skipped: 1, retryable: 1 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("reclaims a failed claim on a later run of the same day and retries the send", async () => {
    const failedClaim = { userId: "u1", status: "failed", attempts: 1, updatedAt: new Date(NOW.getTime() - 600_000) };
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      claims: [failedClaim],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1) })], []],
    });
    prisma.emailDigestClaim.findMany
      .mockResolvedValueOnce([failedClaim]) // claim preload
      .mockResolvedValueOnce([]); // retryable sweep: all done after this run
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 1, skipped: 0, retryable: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // CAS-style re-acquisition of the failed claim.
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        dayUtc: "2026-08-29",
        OR: [
          { status: "failed", attempts: { lt: DIGEST_CLAIM_MAX_ATTEMPTS } },
          { status: "pending", updatedAt: { lt: expect.any(Date) } },
        ],
      },
      data: { status: "pending", attempts: { increment: 1 } },
    });
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", dayUtc: "2026-08-29" },
      data: { status: "succeeded", sentAt: NOW },
    });
  });

  it("stops retrying a recipient whose claim reached the attempt cap", async () => {
    const maxedClaim = {
      userId: "u1",
      status: "failed",
      attempts: DIGEST_CLAIM_MAX_ATTEMPTS,
      updatedAt: new Date(NOW.getTime() - 600_000),
    };
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      claims: [maxedClaim],
    });
    prisma.emailDigestClaim.findMany
      .mockResolvedValueOnce([maxedClaim]) // claim preload
      .mockResolvedValueOnce([]); // retryable sweep: capped claim is filtered out
    prisma.emailDigestClaim.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 0, skipped: 1, retryable: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a recipient whose fresh pending claim is owned by another replica", async () => {
    const pendingClaim = { userId: "u1", status: "pending", attempts: 1, updatedAt: NOW };
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      claims: [pendingClaim],
    });
    prisma.emailDigestClaim.findMany
      .mockResolvedValueOnce([pendingClaim]) // claim preload
      .mockResolvedValueOnce([]); // retryable sweep: fresh foreign pending claim is not ours

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 0, skipped: 1, retryable: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a recipient when another replica wins the claim creation race", async () => {
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
    });
    prisma.emailDigestClaim.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
      })
    );
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 0, skipped: 1, retryable: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("marks a transient SMTP failure durably as failed on the claim", async () => {
    const prisma = makePrisma({
      users: [{ id: "u1", name: "Ada", email: "ada@example.com", settings: { emailChannel: { digest: true } } }],
      user: { id: "u1", name: "Ada", email: "ada@example.com", settings: {} },
      projects: [projectP1],
      taskCalls: [[taskRow({ id: "t1", dueDate: isoDay(-1) })], []],
    });
    sendEmail.mockRejectedValueOnce(new Error("smtp 421 try again later"));
    // Retryable sweep: the just-failed claim has attempts left.
    prisma.emailDigestClaim.findMany
      .mockResolvedValueOnce([]) // claim preload
      .mockResolvedValueOnce([{ id: "claim-1" }]); // retryable sweep
    getAccessibleProjectIds.mockResolvedValue(["p1"]);

    const result = await sendDueSoonDigests(NOW, prisma as never);

    expect(result).toEqual({ sent: 0, skipped: 0, retryable: 1 });
    expect(prisma.emailDigestClaim.updateMany).toHaveBeenCalledWith({
      where: { userId: "u1", dayUtc: "2026-08-29" },
      data: { status: "failed", lastError: "smtp 421 try again later" },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("is a no-op when SMTP is unconfigured", async () => {
    isEmailConfigured.mockReturnValue(false);
    const prisma = makePrisma({});
    const result = await sendDueSoonDigests(NOW, prisma as never);
    expect(result).toEqual({ sent: 0, skipped: 0, retryable: 0 });
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
    expect(first).toEqual({ sent: 1, skipped: 0, retryable: 0 });
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
    expect(nextDay).toEqual({ sent: 1, skipped: 0, retryable: 0 });
  });

  it("does nothing when email is not configured", async () => {
    isEmailConfigured.mockReturnValue(false);
    prismaRef.current = makePrisma({}) as never;
    const result = await runDailyDigestJob(NOW);
    expect(result).toEqual({ sent: 0, skipped: 0, retryable: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not mark the UTC day complete when a run throws, so its next tick retries", async () => {
    const failedPrisma = makePrisma({});
    failedPrisma.user.findMany.mockRejectedValueOnce(new Error("database interrupted"));
    prismaRef.current = failedPrisma as never;

    await expect(runDailyDigestJob(NOW)).rejects.toThrow("database interrupted");

    // A successful retry on the same calendar day must not be skipped by the
    // process-level guard; the DB-backed per-user guard remains in place.
    prismaRef.current = makePrisma({ users: [] }) as never;
    await expect(runDailyDigestJob(NOW)).resolves.toEqual({ sent: 0, skipped: 0, retryable: 0 });
  });
});
