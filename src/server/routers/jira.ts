import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { requireProjectAccess, requireTaskAccess } from "../authz";
import { encryptSecret } from "@/lib/secret-crypto";
import { withSecretRotationLock } from "../services/ai/secret-reencryption";
import { JiraClient, normalizeJiraSite } from "../services/jira/client";
import {
  deliverJiraComment,
  exportJiraTask,
  syncJiraConnection,
} from "../services/jira/sync";

const publicSelect = {
  id: true,
  siteUrl: true,
  email: true,
  projectId: true,
  enabled: true,
  intervalMinutes: true,
  defaultDueDays: true,
  statusMapping: true,
  participantFieldId: true,
  lastSyncedAt: true,
  lastError: true,
} as const;
export const jiraRouter = createTRPCRouter({
  connection: protectedProcedure.query(({ ctx }) =>
    ctx.prisma.jiraConnection.findUnique({
      where: { userId: ctx.session.user.id },
      select: publicSelect,
    }),
  ),
  save: protectedProcedure
    .input(
      z.object({
        siteUrl: z.string().url(),
        email: z.string().email(),
        apiToken: z.string().max(4096).optional(),
        projectId: z.string().cuid(),
        statusMapping: z
          .record(z.string().cuid(), z.string().trim().min(1).max(100))
          .default({}),
        defaultDueDays: z.number().int().min(1).max(3650).default(7),
        intervalMinutes: z.number().int().min(1).max(1440).default(5),
        participantFieldId: z
          .string()
          .regex(/^customfield_\d+$/)
          .optional(),
        enabled: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(
        ctx.prisma,
        ctx.session.user.id,
        input.projectId,
        {
          permissions: [
            "task_read",
            "task_create",
            "task_update",
            "task_comment",
          ],
        },
      );
      const current = await ctx.prisma.jiraConnection.findUnique({
        where: { userId: ctx.session.user.id },
      });
      const siteUrl = normalizeJiraSite(input.siteUrl);
      if (
        current &&
        (current.siteUrl !== siteUrl ||
          current.projectId !== input.projectId ||
          current.email !== input.email) &&
        (await ctx.prisma.jiraIssue.count({
          where: { connectionId: current.id },
        }))
      )
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Disconnect before changing the site, account, or destination project of a connection with linked tasks.",
        });
      if (
        current &&
        !input.apiToken &&
        (current.siteUrl !== siteUrl || current.email !== input.email)
      )
        throw new Error(
          "Enter a new API token when changing the Jira site or account",
        );
      if (!input.apiToken && !current) throw new Error("API token is required");
      const encryptedApiToken = input.apiToken
        ? encryptSecret(input.apiToken)
        : current!.encryptedApiToken;
      const client = new JiraClient({
        siteUrl,
        email: input.email,
        encryptedApiToken,
      });
      const myself = await client.request<{ accountId: string }>(
        "/rest/api/3/myself",
      );
      const fields =
        await client.request<
          Array<{ id: string; name: string; schema?: { custom?: string } }>
        >("/rest/api/3/field");
      const participantFieldId =
        input.participantFieldId ||
        fields.find(
          (f) =>
            f.schema?.custom ===
              "com.atlassian.servicedesk:sd-request-participants" ||
            f.name.toLowerCase() === "request participants",
        )?.id ||
        null;
      if (
        participantFieldId &&
        !fields.some((f) => f.id === participantFieldId)
      )
        throw new Error("Request participant field was not found in Jira");
      const statuses = await ctx.prisma.workflowStatus.findMany({
        where: { projectId: input.projectId },
        select: { id: true },
      });
      if (
        Object.keys(input.statusMapping).some(
          (id) => !statuses.some((status) => status.id === id),
        )
      )
        throw new Error(
          "Status mapping must use statuses from the selected Taskito project",
        );
      if (
        new Set(
          Object.values(input.statusMapping).map((name) => name.toLowerCase()),
        ).size !== Object.keys(input.statusMapping).length
      )
        throw new Error("Map each Jira status name to only one Taskito status");
      const { apiToken, ...settings } = input;
      void apiToken;
      return withSecretRotationLock(ctx.prisma, async (tx) => {
        const storedToken = input.apiToken
          ? encryptSecret(input.apiToken)
          : (
              await tx.jiraConnection.findUniqueOrThrow({
                where: { userId: ctx.session.user.id },
              })
            ).encryptedApiToken;
        return tx.jiraConnection.upsert({
          where: { userId: ctx.session.user.id },
          create: {
            ...settings,
            siteUrl,
            userId: ctx.session.user.id,
            accountId: myself.accountId,
            participantFieldId,
            encryptedApiToken: storedToken,
            nextSyncAt: new Date(),
          },
          update: {
            ...settings,
            siteUrl,
            accountId: myself.accountId,
            participantFieldId,
            encryptedApiToken: storedToken,
            nextSyncAt: new Date(),
            lastError: null,
          },
          select: publicSelect,
        });
      });
    }),
  projects: protectedProcedure.query(async ({ ctx }) => {
    const connection = await ctx.prisma.jiraConnection.findUniqueOrThrow({
      where: { userId: ctx.session.user.id },
    });
    return new JiraClient(connection).pages<{
      id: string;
      key: string;
      name: string;
      projectTypeKey: string;
    }>("/rest/api/3/project/search?action=create", "values");
  }),
  requestTypes: protectedProcedure
    .input(z.object({ projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }))
    .query(async ({ ctx, input }) => {
      const connection = await ctx.prisma.jiraConnection.findUniqueOrThrow({
        where: { userId: ctx.session.user.id },
      });
      const client = new JiraClient(connection);
      const desks = await client.pages<{ id: string; projectKey: string }>(
        "/rest/servicedeskapi/servicedesk",
        "values",
        true,
      );
      const desk = desks.find((d) => d.projectKey === input.projectKey);
      if (!desk)
        throw new Error(
          "No accessible Jira service desk found for this project",
        );
      return {
        serviceDeskId: desk.id,
        types: await client.pages<{
          id: string;
          name: string;
          issueTypeId: string;
        }>(
          `/rest/servicedeskapi/servicedesk/${desk.id}/requesttype`,
          "values",
          true,
        ),
      };
    }),
  issueTypes: protectedProcedure
    .input(z.object({ projectKey: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }))
    .query(async ({ ctx, input }) => {
      const connection = await ctx.prisma.jiraConnection.findUniqueOrThrow({
        where: { userId: ctx.session.user.id },
      });
      const client = new JiraClient(connection);
      const result = await client.pages<{
        id: string;
        name: string;
        subtask: boolean;
      }>(
        `/rest/api/3/issue/createmeta/${encodeURIComponent(input.projectKey)}/issuetypes`,
        "issueTypes",
      );
      return result.filter((t) => !t.subtask);
    }),
  sync: protectedProcedure.mutation(async ({ ctx }) => {
    const connection = await ctx.prisma.jiraConnection.findUniqueOrThrow({
      where: { userId: ctx.session.user.id },
    });
    return syncJiraConnection(connection.id, AbortSignal.timeout(5 * 60000));
  }),
  disconnect: protectedProcedure.mutation(async ({ ctx }) => {
    // Local tasks, comments, and attachments are retained. Removing credentials
    // also removes links, preventing future exports under the old account.
    await ctx.prisma.jiraConnection.deleteMany({
      where: { userId: ctx.session.user.id },
    });
    return { success: true };
  }),
  retryComment: protectedProcedure
    .input(
      z.object({
        commentId: z.string().cuid(),
        confirmedNotSent: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const comment = await ctx.prisma.comment.findUniqueOrThrow({
        where: { id: input.commentId },
      });
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, comment.taskId, {
        permission: "task_comment",
      });
      if (
        comment.authorId !== ctx.session.user.id ||
        comment.externalAuthor ||
        comment.jiraSyncState === "synced"
      )
        throw new Error("Only the author can retry an unsent comment");
      if (
        ["sending", "uncertain"].includes(comment.jiraSyncState ?? "") &&
        !input.confirmedNotSent
      )
        throw new Error(
          "Check Jira first, then confirm the comment and attachments were not sent",
        );
      if (comment.jiraSyncState === "sending")
        throw new Error("Delivery is still in progress");
      await ctx.prisma.comment.update({
        where: { id: comment.id },
        data: { jiraSyncState: "pending" },
      });
      await deliverJiraComment(comment.id);
      return { success: true };
    }),
  resolveIssue: protectedProcedure
    .input(
      z.object({
        taskId: z.string().cuid(),
        issueKey: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]*-\d+$/)
          .optional(),
        confirmedNotCreated: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requireTaskAccess(ctx.prisma, ctx.session.user.id, input.taskId, {
        permission: "task_update",
      });
      const link = await ctx.prisma.jiraIssue.findUniqueOrThrow({
        where: { taskId: input.taskId },
        include: { connection: true },
      });
      if (
        link.connection.userId !== ctx.session.user.id ||
        link.issueId ||
        link.syncState === "sending"
      )
        throw new Error("This issue cannot be relinked");
      if (input.issueKey) {
        const remote = await new JiraClient(link.connection).request<{
          id: string;
          key: string;
        }>(`/rest/api/3/issue/${input.issueKey}?fields=summary`);
        await ctx.prisma.jiraIssue.update({
          where: { id: link.id },
          data: {
            issueId: remote.id,
            issueKey: remote.key,
            syncState: "synced",
            lastError: null,
          },
        });
      } else {
        if (link.syncState === "uncertain" && !input.confirmedNotCreated)
          throw new Error(
            "Confirm that Jira did not create the issue before retrying",
          );
        await ctx.prisma.jiraIssue.update({
          where: { id: link.id },
          data: { syncState: "pending" },
        });
        await exportJiraTask(input.taskId);
      }
      return { success: true };
    }),
});
