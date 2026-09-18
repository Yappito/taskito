import { createHash } from "node:crypto";
import {
  Prisma,
  type JiraConnection,
  type JiraIssue,
  type WorkflowStatus,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireProjectAccess, requireTaskAccess } from "@/server/authz";
import { createSchedulerLockConnection } from "@/server/services/scheduler-lock-connection";
import { createTaskWithNextNumber } from "@/server/routers/task";
import {
  readStoredCommentAttachment,
  removeStoredCommentAttachments,
  storeCommentAttachment,
} from "@/server/services/comment-attachments";
import {
  assignedIssueJql,
  JiraApiError,
  JiraClient,
  jiraDocument,
  jiraText,
  type JiraAttachment,
  type JiraComment,
  type JiraIssueData,
} from "./client";

export const jiraError = (error: unknown) =>
  error instanceof JiraApiError
    ? error.message
    : error instanceof Error &&
        (error.name === "TRPCError" ||
          /^(Configure|Linked task|Jira attachment|Internal comments|Your Jira connection)/.test(
            error.message,
          ))
      ? error.message
      : "Sync failed. Check connectivity, Jira permissions, and server configuration.";
async function locked<T>(key: string, fn: () => Promise<T>) {
  const lock = createSchedulerLockConnection();
  try {
    return await lock.runExclusive(
      createHash("sha256").update(`jira:${key}`).digest().readInt32BE(),
      fn,
    );
  } finally {
    await lock.end();
  }
}
export async function usableConnection(userId: string, projectId: string) {
  await requireProjectAccess(prisma, userId, projectId, {
    permissions: ["task_read", "task_create", "task_update", "task_comment"],
  });
  const connection = await prisma.jiraConnection.findUnique({
    where: { userId },
  });
  if (!connection?.enabled || connection.projectId !== projectId)
    throw new Error(
      "Configure an enabled Jira connection for this Taskito project in Settings → Jira.",
    );
  return connection;
}
export async function prepareJiraComment(
  userId: string,
  taskId: string,
  visibility: string,
  db = prisma,
) {
  const issue = await db.jiraIssue.findUnique({ where: { taskId } });
  if (!issue) return false;
  const task = await requireTaskAccess(prisma, userId, taskId, {
    permission: "task_comment",
  });
  const connection = await usableConnection(userId, task.projectId);
  if (connection.siteUrl !== issue.siteUrl)
    throw new Error(
      "Your Jira connection must use the same site as this ticket.",
    );
  if (!issue.serviceDeskId && issue.issueId && visibility === "internal")
    throw new Error(
      "Internal Jira comments require a Jira Service Management request. Choose Public for this Jira issue.",
    );
  return true;
}

async function saveAttachment(
  client: JiraClient,
  commentId: string,
  attachment: JiraAttachment,
) {
  if (
    await prisma.commentAttachment.findUnique({
      where: {
        commentId_jiraAttachmentId: {
          commentId,
          jiraAttachmentId: attachment.id,
        },
      },
    })
  )
    return;
  if (attachment.size > 20 * 1024 * 1024)
    throw new Error("Jira attachment exceeds Taskito's 20MB limit");
  const bytes = await client.download(attachment.id);
  const stored = await storeCommentAttachment(
    new File([new Uint8Array(bytes)], attachment.filename, {
      type: attachment.mimeType,
    }),
  );
  try {
    await prisma.commentAttachment.create({
      data: { ...stored, commentId, jiraAttachmentId: attachment.id },
    });
  } catch (error) {
    await removeStoredCommentAttachments([stored]);
    throw error;
  }
}

async function importComments(
  client: JiraClient,
  connection: JiraConnection,
  link: JiraIssue,
  remote: JiraIssueData,
) {
  const attachmentErrors: string[] = [];
  const importAttachment = async (
    commentId: string,
    attachment: JiraAttachment,
  ) => {
    try {
      await saveAttachment(client, commentId, attachment);
    } catch (error) {
      attachmentErrors.push(`${attachment.filename}: ${jiraError(error)}`);
    }
  };
  const issueKey = encodeURIComponent(remote.key);
  const comments = link.serviceDeskId
    ? await client.pages<JiraComment>(
        `/rest/servicedeskapi/request/${issueKey}/comment`,
        "values",
        true,
      )
    : await client.pages<JiraComment>(
        `/rest/api/3/issue/${issueKey}/comment?expand=properties`,
        "comments",
      );
  for (const comment of comments) {
    const property = comment.properties?.find(
      (item) => item.key === "sd.public.comment",
    )?.value as { internal?: boolean } | undefined;
    const visibility = link.serviceDeskId
      ? comment.public === true
        ? "public"
        : "internal"
      : property?.internal || comment.visibility
        ? "internal"
        : "public";
    const content = jiraText(comment.body).trim();
    const created =
      typeof comment.created === "string"
        ? comment.created
        : comment.created?.iso8601;
    const existing = await prisma.comment.findUnique({
      where: {
        taskId_jiraCommentId: {
          taskId: link.taskId,
          jiraCommentId: comment.id,
        },
      },
    });
    // Keep locally authored comments intact while their delivery is unresolved.
    if (existing && existing.jiraSyncState !== "synced") continue;
    const local = await prisma.comment.upsert({
      where: {
        taskId_jiraCommentId: {
          taskId: link.taskId,
          jiraCommentId: comment.id,
        },
      },
      create: {
        taskId: link.taskId,
        authorId: connection.userId,
        content,
        visibility,
        externalAuthor: comment.author?.displayName ?? "Jira user",
        jiraCommentId: comment.id,
        jiraSyncState: "synced",
        ...(created ? { createdAt: new Date(created) } : {}),
      },
      update: { content, visibility },
    });
    if (
      !existing ||
      existing.content !== content ||
      existing.visibility !== visibility
    )
      await prisma.task.update({
        where: { id: link.taskId },
        data: { commentThreadVersion: { increment: 1 } },
      });
    if (link.serviceDeskId) {
      const attachments = await client.pages<JiraAttachment>(
        `/rest/servicedeskapi/request/${issueKey}/comment/${encodeURIComponent(comment.id)}/attachment`,
        "values",
        true,
      );
      for (const attachment of attachments)
        await importAttachment(local.id, attachment);
    }
  }
  // Standard Jira attachments belong to the issue, not a comment. Preserve
  // them in an explicitly labelled attachment entry without guessing authors.
  if (!link.serviceDeskId && remote.fields.attachment?.length) {
    const holder = await prisma.comment.upsert({
      where: {
        taskId_jiraCommentId: {
          taskId: link.taskId,
          jiraCommentId: "issue-attachments",
        },
      },
      create: {
        taskId: link.taskId,
        authorId: connection.userId,
        externalAuthor: "Jira",
        content: "Jira ticket attachments",
        visibility: "public",
        jiraCommentId: "issue-attachments",
        jiraSyncState: "synced",
      },
      update: {},
    });
    for (const attachment of remote.fields.attachment) {
      if (
        !(await prisma.commentAttachment.findFirst({
          where: {
            comment: { taskId: link.taskId },
            jiraAttachmentId: attachment.id,
          },
        }))
      )
        await importAttachment(holder.id, attachment);
    }
  }
  if (attachmentErrors.length)
    throw new Error(
      `Jira attachment import failed: ${attachmentErrors.slice(0, 5).join("; ")}`,
    );
}

function mappedFields(
  remote: JiraIssueData,
  statuses: WorkflowStatus[],
  connection: JiraConnection,
) {
  const done =
    Boolean(remote.fields.resolution) ||
    /^(closed|resolved)$/i.test(remote.fields.status.name) ||
    remote.fields.status.statusCategory.key === "done";
  const mapping = connection.statusMapping as Record<string, string>;
  const status =
    statuses.find(
      (s) =>
        mapping?.[s.id]?.toLowerCase() ===
        remote.fields.status.name.toLowerCase(),
    ) ??
    statuses.find(
      (s) => s.name.toLowerCase() === remote.fields.status.name.toLowerCase(),
    ) ??
    statuses.find((s) =>
      done
        ? s.isFinal || s.category === "done"
        : remote.fields.status.statusCategory.key === "indeterminate"
          ? s.category === "active"
          : s.category === "todo",
    ) ??
    (!done ? statuses.find((s) => !s.isFinal) : undefined);
  if (!status)
    throw new Error(
      "Configure Taskito workflow statuses before importing Jira tickets",
    );
  const body = jiraText(remote.fields.description).trim();
  const dueDate = remote.fields.duedate
    ? new Date(`${remote.fields.duedate}T12:00:00Z`)
    : undefined;
  const assigneeId =
    remote.fields.assignee?.accountId === connection.accountId
      ? connection.userId
      : null;
  const priorityName = remote.fields.priority?.name.toLowerCase() ?? "";
  const priority = /highest|critical|blocker/.test(priorityName)
    ? "urgent"
    : /high/.test(priorityName)
      ? "high"
      : /low|lowest/.test(priorityName)
        ? "low"
        : /medium|normal/.test(priorityName)
          ? "medium"
          : "none";
  const data = {
    title: remote.fields.summary,
    body,
    description: body,
    statusId: status.id,
    closedAt: done ? new Date(remote.fields.updated) : null,
    assigneeId,
    priority,
  } as const;
  return { data, dueDate, assigneeId };
}

async function importIssue(
  client: JiraClient,
  connection: JiraConnection,
  remote: JiraIssueData,
) {
  await requireProjectAccess(prisma, connection.userId, connection.projectId, {
    permissions: ["task_read", "task_create", "task_update", "task_comment"],
  });
  const statuses = await prisma.workflowStatus.findMany({
    where: { projectId: connection.projectId },
    orderBy: { order: "asc" },
  });
  let link = await prisma.jiraIssue.findUnique({
    where: {
      connectionId_issueId: { connectionId: connection.id, issueId: remote.id },
    },
  });
  if (
    link?.syncState === "synced" &&
    link.outboundVersion === link.sentVersion &&
    link.remoteUpdatedAt?.getTime() ===
      new Date(remote.fields.updated).getTime() &&
    link.lastSyncedAt &&
    Date.now() - link.lastSyncedAt.getTime() < 3600000
  )
    return;
  const { data, dueDate, assigneeId } = mappedFields(
    remote,
    statuses,
    connection,
  );
  if (!link) {
    const task = await createTaskWithNextNumber(
      prisma,
      connection.projectId,
      (tx, taskNumber) =>
        tx.task.create({
          data: {
            ...data,
            projectId: connection.projectId,
            taskNumber,
            dueDate:
              dueDate ??
              new Date(Date.now() + connection.defaultDueDays * 86400000),
            creatorId: connection.userId,
            ...(!assigneeId
              ? { participants: { create: { userId: connection.userId } } }
              : {}),
            jiraIssue: {
              create: {
                connectionId: connection.id,
                siteUrl: connection.siteUrl,
                issueId: remote.id,
                issueKey: remote.key,
              },
            },
          },
        }),
    );
    link = await prisma.jiraIssue.findUniqueOrThrow({
      where: { taskId: task.id },
    });
  }
  await locked(`task:${link.taskId}`, async () => {
    // Moving a linked task out of the configured project suspends sync.
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: link!.taskId },
    });
    if (task.projectId !== connection.projectId)
      throw new Error(
        "Linked task moved to another project; sync is suspended",
      );
    // Search results may predate a concurrent outbound delivery. Fetch again
    // under the task lock before applying fields, then CAS against the local
    // task timestamp captured before that request.
    remote = await client.request<JiraIssueData>(
      `/rest/api/3/issue/${encodeURIComponent(remote.id)}`,
    );
    const { data, dueDate } = mappedFields(remote, statuses, connection);
    const fresh = await prisma.jiraIssue.findUniqueOrThrow({
      where: { id: link!.id },
    });
    if (fresh.outboundVersion === fresh.sentVersion) {
      // Compare-and-swap with the task timestamp prevents overwriting an edit
      // made after this import read the local task.
      await prisma.task.updateMany({
        where: { id: task.id, updatedAt: task.updatedAt },
        data: { ...data, ...(dueDate ? { dueDate } : {}) },
      });
    }
    const sourceTag = await prisma.tag.upsert({
      where: {
        projectId_name: {
          projectId: connection.projectId,
          name: `Jira: ${remote.fields.project.key}`,
        },
      },
      create: {
        projectId: connection.projectId,
        name: `Jira: ${remote.fields.project.key}`,
        color: "#2684ff",
      },
      update: {},
    });
    await prisma.taskTag.upsert({
      where: { taskId_tagId: { taskId: task.id, tagId: sourceTag.id } },
      create: { taskId: task.id, tagId: sourceTag.id },
      update: {},
    });
    const info =
      remote.fields.project.projectTypeKey === "service_desk"
        ? await client.requestInfo(remote.key)
        : null;
    link = await prisma.jiraIssue.update({
      where: { id: link!.id },
      data: {
        issueKey: remote.key,
        jiraProjectKey: remote.fields.project.key,
        jiraProjectName: remote.fields.project.name,
        serviceDeskId: info?.serviceDeskId ?? null,
      },
    });
    try {
      const history = await client.pages<Prisma.InputJsonObject>(
        `/rest/api/3/issue/${encodeURIComponent(remote.key)}/changelog`,
        "values",
      );
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: { history },
      });
      await importComments(client, connection, link, remote);
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: {
          history,
          remoteUpdatedAt: new Date(remote.fields.updated),
          lastSyncedAt: new Date(),
        },
      });
      if (fresh.outboundVersion === fresh.sentVersion)
        await prisma.jiraIssue.updateMany({
          where: { id: link.id, outboundVersion: fresh.outboundVersion },
          data: { syncState: "synced", lastError: null },
        });
    } catch (error) {
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: { syncState: "failed", lastError: jiraError(error) },
      });
      throw error;
    }
  });
}

function uncertain(error: unknown) {
  return !(error instanceof JiraApiError) || error.status >= 500;
}

export async function deliverJiraComment(
  commentId: string,
  signal?: AbortSignal,
) {
  const initial = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!initial?.jiraSyncState || initial.jiraSyncState === "synced") return;
  return locked(`task:${initial.taskId}`, async () => {
    const comment = await prisma.comment.findUniqueOrThrow({
      where: { id: commentId },
      include: { attachments: true, task: { include: { jiraIssue: true } } },
    });
    if (!["pending", "failed"].includes(comment.jiraSyncState ?? "")) return;
    const link = comment.task.jiraIssue;
    if (!link?.issueId) return;
    await prisma.comment.update({
      where: { id: commentId },
      data: { jiraAttemptAt: new Date() },
    });
    let sending = false;
    try {
      const connection = await usableConnection(
        comment.authorId,
        comment.task.projectId,
      );
      if (connection.siteUrl !== link.siteUrl)
        throw new Error("Jira site mismatch");
      if (!link.serviceDeskId && comment.visibility !== "public")
        throw new Error(
          "Internal comments require a Service Management request",
        );
      const client = new JiraClient(connection, signal);
      const key = encodeURIComponent(link.issueKey!);
      const temporaryAttachmentIds: string[] = [];
      for (const attachment of comment.attachments) {
        if (!link.serviceDeskId && attachment.jiraAttachmentId) continue;
        const bytes = await readStoredCommentAttachment(attachment);
        if (link.serviceDeskId) {
          const uploaded = (await client.upload(
            `/rest/servicedeskapi/servicedesk/${encodeURIComponent(link.serviceDeskId)}/attachTemporaryFile`,
            attachment.originalName,
            bytes,
          )) as {
            temporaryAttachments: Array<{ temporaryAttachmentId: string }>;
          };
          temporaryAttachmentIds.push(
            ...uploaded.temporaryAttachments.map(
              (a) => a.temporaryAttachmentId,
            ),
          );
        } else {
          // Mark the ambiguous window before every non-idempotent remote write.
          await prisma.comment.update({
            where: { id: commentId },
            data: { jiraSyncState: "sending", jiraAttemptAt: new Date() },
          });
          sending = true;
          const uploaded = (await client.upload(
            `/rest/api/3/issue/${key}/attachments`,
            attachment.originalName,
            bytes,
          )) as JiraAttachment[];
          await prisma.commentAttachment.update({
            where: { id: attachment.id },
            data: { jiraAttachmentId: uploaded[0].id },
          });
          sending = false;
        }
      }
      await prisma.comment.update({
        where: { id: commentId },
        data: { jiraSyncState: "sending", jiraAttemptAt: new Date() },
      });
      sending = true;
      let id: string;
      if (link.serviceDeskId && temporaryAttachmentIds.length) {
        const result = await client.request<{
          comment: { id: string };
          attachments: { values: JiraAttachment[] };
        }>(`/rest/servicedeskapi/request/${key}/attachment`, {
          method: "POST",
          body: JSON.stringify({
            public: comment.visibility === "public",
            additionalComment: { body: comment.content || "Attachments" },
            temporaryAttachmentIds,
          }),
        });
        id = result.comment.id;
        for (let index = 0; index < comment.attachments.length; index++) {
          if (result.attachments?.values[index])
            await prisma.commentAttachment.update({
              where: { id: comment.attachments[index].id },
              data: { jiraAttachmentId: result.attachments.values[index].id },
            });
        }
      } else {
        const body = link.serviceDeskId
          ? { body: comment.content, public: comment.visibility === "public" }
          : {
              body: jiraDocument(
                comment.content +
                  comment.attachments
                    .map((a) => `\nAttachment: ${a.originalName}`)
                    .join(""),
              ),
            };
        const result = await client.request<{ id: string }>(
          link.serviceDeskId
            ? `/rest/servicedeskapi/request/${key}/comment`
            : `/rest/api/3/issue/${key}/comment`,
          { method: "POST", body: JSON.stringify(body) },
        );
        id = result.id;
      }
      await prisma.comment.update({
        where: { id: commentId },
        data: {
          jiraCommentId: id,
          jiraSyncState: "synced",
          jiraSyncError: null,
        },
      });
    } catch (error) {
      await prisma.comment.update({
        where: { id: commentId },
        data: {
          jiraSyncState: sending && uncertain(error) ? "uncertain" : "failed",
          jiraSyncError:
            sending && uncertain(error)
              ? "Jira may have accepted this comment or attachment. Check Jira before retrying to avoid duplicates."
              : jiraError(error),
        },
      });
    }
  });
}

export async function exportJiraTask(
  taskId: string,
  signal?: AbortSignal,
  connectionLockHeld = false,
): Promise<void | null> {
  // Serialize issue creation with discovery: Jira can return the newly created
  // issue in search before we have persisted its remote ID on the local task.
  if (!connectionLockHeld) {
    const link = await prisma.jiraIssue.findUnique({ where: { taskId } });
    if (!link) return;
    return locked(`connection:${link.connectionId}`, () =>
      exportJiraTask(taskId, signal, true),
    );
  }
  return locked(`task:${taskId}`, async () => {
    const link = await prisma.jiraIssue.findUnique({
      where: { taskId },
      include: { task: true, connection: true },
    });
    if (
      !link ||
      link.issueId ||
      !["pending", "failed"].includes(link.syncState)
    )
      return;
    let sending = false;
    try {
      const connection = await usableConnection(
        link.connection.userId,
        link.task.projectId,
      );
      const client = new JiraClient(connection, signal);
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: { syncState: "sending", attemptAt: new Date() },
      });
      sending = true;
      const remote =
        link.serviceDeskId && link.requestTypeId
          ? await client
              .request<{
                issueId: string;
                issueKey: string;
              }>("/rest/servicedeskapi/request", {
                method: "POST",
                body: JSON.stringify({
                  serviceDeskId: link.serviceDeskId,
                  requestTypeId: link.requestTypeId,
                  requestFieldValues: {
                    summary: link.task.title,
                    description:
                      link.task.body ?? jiraText(link.task.description),
                  },
                }),
              })
              .then((r) => ({ id: r.issueId, key: r.issueKey }))
          : await client.request<{ id: string; key: string }>(
              "/rest/api/3/issue",
              {
                method: "POST",
                body: JSON.stringify({
                  fields: {
                    project: { key: link.jiraProjectKey },
                    issuetype: { id: link.issueTypeId },
                    summary: link.task.title,
                    description: jiraDocument(
                      link.task.body ?? jiraText(link.task.description),
                    ),
                    assignee: { accountId: connection.accountId },
                    duedate: link.task.dueDate.toISOString().slice(0, 10),
                    labels: [`taskito-${taskId}`],
                  },
                }),
              },
            );
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: {
          issueId: remote.id,
          issueKey: remote.key,
          syncState: "synced",
          lastError: null,
        },
      });
    } catch (error) {
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: {
          syncState: sending && uncertain(error) ? "uncertain" : "failed",
          lastError:
            sending && uncertain(error)
              ? "Jira may have created this issue. Check Jira and link its key in Taskito before retrying."
              : jiraError(error),
        },
      });
    }
  });
}

export async function syncJiraConnection(id: string, signal?: AbortSignal) {
  return locked(`connection:${id}`, async () => {
    const connection = await prisma.jiraConnection.findUniqueOrThrow({
      where: { id },
    });
    if (!connection.enabled) return { imported: 0 };
    let imported = 0;
    try {
      await usableConnection(connection.userId, connection.projectId);
      const client = new JiraClient(connection, signal);
      const links = await prisma.jiraIssue.findMany({
        where: { connectionId: id },
      });
      // A process dying mid-write leaves a durable state requiring review.
      await prisma.jiraIssue.updateMany({
        where: {
          connectionId: id,
          syncState: "sending",
          attemptAt: { lt: new Date(Date.now() - 10 * 60000) },
        },
        data: {
          syncState: "uncertain",
          lastError:
            "Previous delivery was interrupted. Check Jira before retrying.",
        },
      });
      await prisma.comment.updateMany({
        where: {
          task: { jiraIssue: { connectionId: id } },
          jiraSyncState: "sending",
          jiraAttemptAt: { lt: new Date(Date.now() - 10 * 60000) },
        },
        data: {
          jiraSyncState: "uncertain",
          jiraSyncError:
            "Previous delivery was interrupted. Check Jira before retrying.",
        },
      });
      for (const link of links.filter((l) => !l.issueId)) {
        signal?.throwIfAborted();
        await exportJiraTask(link.taskId, signal, true);
      }
      for (const link of links.filter(
        (l) => l.issueId && l.outboundVersion > l.sentVersion,
      )) {
        signal?.throwIfAborted();
        await deliverJiraFields(link.taskId, signal);
      }
      const seen = new Set<string>();
      const failures: string[] = [];
      for await (const remote of client.search(
        assignedIssueJql(connection.participantFieldId),
      )) {
        signal?.throwIfAborted();
        if (/^(closed|resolved)$/i.test(remote.fields.status.name)) continue;
        seen.add(remote.id);
        try {
          await importIssue(client, connection, remote);
          imported++;
        } catch (error) {
          if (
            error instanceof JiraApiError &&
            [401, 429].includes(error.status)
          )
            throw error;
          failures.push(`${remote.key}: ${jiraError(error)}`);
        }
      }
      // Continue updating linked tickets after resolution/reassignment; they no
      // longer match discovery, but closure and final comments still matter.
      for (const link of links.filter(
        (l) => l.issueId && !seen.has(l.issueId),
      )) {
        signal?.throwIfAborted();
        try {
          const remote = await client.request<JiraIssueData>(
            `/rest/api/3/issue/${encodeURIComponent(link.issueId!)}`,
          );
          await importIssue(client, connection, remote);
        } catch (error) {
          failures.push(`${link.issueKey}: ${jiraError(error)}`);
          await prisma.jiraIssue.update({
            where: { id: link.id },
            data: { lastError: jiraError(error), syncState: "failed" },
          });
        }
      }
      const comments = await prisma.comment.findMany({
        where: {
          task: { jiraIssue: { connectionId: id } },
          jiraSyncState: { in: ["pending", "failed"] },
        },
        select: { id: true },
        take: 100,
        orderBy: [
          { jiraAttemptAt: { sort: "asc", nulls: "first" } },
          { createdAt: "asc" },
        ],
      });
      for (const comment of comments) {
        signal?.throwIfAborted();
        await deliverJiraComment(comment.id, signal);
      }
      await prisma.jiraConnection.update({
        where: { id },
        data: {
          lastSyncedAt: new Date(),
          nextSyncAt: new Date(Date.now() + connection.intervalMinutes * 60000),
          lastError: failures.length ? failures.slice(0, 5).join("\n") : null,
        },
      });
      return { imported, errors: failures.length };
    } catch (error) {
      await prisma.jiraConnection.update({
        where: { id },
        data: {
          lastError: jiraError(error),
          nextSyncAt: new Date(
            Date.now() +
              Math.max(
                connection.intervalMinutes * 60,
                error instanceof JiraApiError ? error.retryAfter : 60,
              ) *
                1000,
          ),
        },
      });
      return { imported, errors: 1 };
    }
  });
}
export async function processJiraSync(signal?: AbortSignal) {
  const connections = await prisma.jiraConnection.findMany({
    where: { enabled: true, nextSyncAt: { lte: new Date() } },
    select: { id: true },
    take: 25,
    orderBy: { nextSyncAt: "asc" },
  });
  for (const connection of connections) {
    signal?.throwIfAborted();
    await syncJiraConnection(connection.id, signal);
  }
  return { processed: connections.length };
}

/** Idempotent field writes retry safely. Status changes use live transitions. */
export async function deliverJiraFields(taskId: string, signal?: AbortSignal) {
  return locked(`task:${taskId}`, async () => {
    const link = await prisma.jiraIssue.findUnique({
      where: { taskId },
      include: { task: { include: { status: true } }, connection: true },
    });
    if (!link?.issueId || link.outboundVersion <= link.sentVersion) return;
    try {
      const connection = await usableConnection(
        link.outboundUserId ?? link.connection.userId,
        link.task.projectId,
      );
      if (connection.siteUrl !== link.siteUrl)
        throw new Error("Jira site mismatch");
      const client = new JiraClient(connection, signal);
      const key = encodeURIComponent(link.issueKey!);
      const fields = {
        ...(link.outboundFields.includes("title")
          ? { summary: link.task.title }
          : {}),
        ...(link.outboundFields.includes("body")
          ? {
              description: jiraDocument(
                link.task.body ?? jiraText(link.task.description),
              ),
            }
          : {}),
        ...(link.outboundFields.includes("dueDate")
          ? { duedate: link.task.dueDate.toISOString().slice(0, 10) }
          : {}),
      };
      if (Object.keys(fields).length)
        await client.request(`/rest/api/3/issue/${key}`, {
          method: "PUT",
          body: JSON.stringify({ fields }),
        });
      const targetStatus =
        (connection.statusMapping as Record<string, string>)?.[
          link.task.status.id
        ] || link.task.status.name;
      const remote = await client.request<JiraIssueData>(
        `/rest/api/3/issue/${key}?fields=status`,
      );
      if (
        link.outboundStatus &&
        remote.fields.status.name.toLowerCase() !== targetStatus.toLowerCase()
      ) {
        const { transitions } = await client.request<{
          transitions: Array<{
            id: string;
            to: { name: string; statusCategory: { key: string } };
          }>;
        }>(`/rest/api/3/issue/${key}/transitions`);
        const matching = transitions.filter(
          (t) => t.to.name.toLowerCase() === targetStatus.toLowerCase(),
        );
        if (matching.length !== 1)
          throw new Error(
            `No unique Jira transition to “${targetStatus}”. Check the status mapping in Settings → Jira and Jira workflow permissions.`,
          );
        await client.request(`/rest/api/3/issue/${key}/transitions`, {
          method: "POST",
          body: JSON.stringify({ transition: { id: matching[0].id } }),
        });
      }
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: {
          sentVersion: link.outboundVersion,
          lastError: null,
          syncState: "synced",
        },
      });
      await prisma.jiraIssue.updateMany({
        where: { id: link.id, outboundVersion: link.outboundVersion },
        data: { outboundStatus: false, outboundFields: [] },
      });
    } catch (error) {
      await prisma.jiraIssue.update({
        where: { id: link.id },
        data: {
          syncState: "failed",
          lastError:
            error instanceof Error &&
            error.message.startsWith("No unique Jira transition")
              ? error.message
              : jiraError(error),
        },
      });
    }
  });
}
