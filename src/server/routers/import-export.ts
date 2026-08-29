import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, protectedProcedure } from "../trpc";
import { requireProjectAccess, canAccessProject } from "../authz";
import { createTaskWithNextNumber } from "./task";
import {
  analyzeImportCsv,
  formatImportAbortMessage,
  ImportLimitError,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
  parseImportDate,
  type ImportColumnMapping,
  type ImportIssue,
} from "../services/task-transfer";

/** Custom field values are stored as JSON; empty strings mean "no value". */
const importMappingSchema = z.record(z.string(), z.string());

interface StatusLike {
  id: string;
  name: string;
  category: string;
  isFinal: boolean;
  autoArchive: boolean;
  autoArchiveDays: number;
  order: number;
}

type TaskNumberClient = Parameters<typeof createTaskWithNextNumber>[0];

function startOfToday(): Date {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

function coerceCustomFieldValue(
  field: { name: string; type: string; required: boolean; options: unknown },
  rawValue: string
): string | number | null {
  const value = rawValue.trim();
  if (value === "") return null;

  if (field.type === "number") {
    const numeric = Number(value);
    if (Number.isNaN(numeric)) {
      throw new Error(`Custom field "${field.name}" requires a numeric value`);
    }
    return numeric;
  }

  if (field.type === "date") {
    const parsed = parseImportDate(value);
    if (!parsed) {
      throw new Error(`Custom field "${field.name}" requires a valid date value`);
    }
    return parsed.toISOString();
  }

  if (field.type === "select") {
    const choices = Array.isArray((field.options as { choices?: unknown } | null)?.choices)
      ? ((field.options as { choices?: unknown[] }).choices as unknown[]).filter(
          (choice): choice is string => typeof choice === "string"
        )
      : [];
    if (choices.length > 0 && !choices.includes(value)) {
      throw new Error(`Custom field "${field.name}" requires one of the configured choices`);
    }
    return value;
  }

  return value;
}

function mapAnalysisLimitError(error: unknown): never {
  if (error instanceof ImportLimitError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
  }
  throw error;
}

/** CSV import router: preview and commit task imports (migration in). */
export const importExportRouter = createTRPCRouter({
  /**
   * Parses an import CSV and returns the column mapping proposal, a preview of
   * the first rows, row-level issues, and what a commit would create.
   */
  previewCsv: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        csv: z.string().min(1, "CSV content is required").max(MAX_IMPORT_BYTES),
        mapping: importMappingSchema.optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        permission: "task_create",
      });

      const project = await ctx.prisma.project.findUnique({
        where: { id: input.projectId },
        select: { id: true },
      });
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }

      const customFields = await ctx.prisma.customField.findMany({
        where: { projectId: input.projectId },
        orderBy: [{ order: "asc" }, { name: "asc" }],
      });

      let analysis;
      try {
        analysis = analyzeImportCsv(
          input.csv,
          customFields,
          input.mapping as ImportColumnMapping | undefined
        );
      } catch (error) {
        mapAnalysisLimitError(error);
      }

      const existingStatuses = await ctx.prisma.workflowStatus.findMany({
        where: { projectId: input.projectId },
        select: { name: true },
      });
      const existingTags = await ctx.prisma.tag.findMany({
        where: { projectId: input.projectId },
        select: { name: true },
      });
      const knownUsers = analysis.assigneeReferences.length
        ? await ctx.prisma.user.findMany({
            where: {
              email: { in: analysis.assigneeReferences.map((entry) => entry.email) },
              disabledAt: null,
            },
            select: { email: true },
          })
        : [];
      const knownEmails = new Set(knownUsers.map((user) => user.email?.toLowerCase()));

      const statusNames = new Set(existingStatuses.map((status) => status.name.toLowerCase()));
      const tagNames = new Set(existingTags.map((tag) => tag.name.toLowerCase()));

      const issues = [...analysis.issues];
      for (const reference of analysis.assigneeReferences) {
        if (!knownEmails.has(reference.email.toLowerCase())) {
          issues.push({
            line: reference.line,
            message: `Assignee "${reference.email}" was not found; the task will be left unassigned`,
          });
        }
      }

      return {
        columns: analysis.columns,
        mapping: analysis.mapping,
        rows: analysis.rows,
        totalRows: analysis.totalRows,
        issues,
        wouldCreate: {
          statuses: analysis.statuses.filter((name) => !statusNames.has(name.toLowerCase())),
          tags: analysis.tags.filter((name) => !tagNames.has(name.toLowerCase())),
        },
      };
    }),

  /**
   * Commits an import: creates missing statuses/tags only when allowed and
   * permitted, then creates every task in a single transaction. Any hard row
   * error aborts the whole import before the transaction starts.
   */
  commitCsv: protectedProcedure
    .input(
      z.object({
        projectId: z.string().cuid(),
        csv: z.string().min(1, "CSV content is required").max(MAX_IMPORT_BYTES),
        mapping: importMappingSchema.optional(),
        createMissing: z
          .object({
            statuses: z.boolean(),
            tags: z.boolean(),
          })
          .default({ statuses: false, tags: false }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
        permission: "task_create",
      });

      const project = await ctx.prisma.project.findUnique({
        where: { id: input.projectId },
        select: { id: true, key: true },
      });
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }

      const [statuses, tags, customFields] = await Promise.all([
        ctx.prisma.workflowStatus.findMany({
          where: { projectId: input.projectId },
          orderBy: { order: "asc" },
        }),
        ctx.prisma.tag.findMany({ where: { projectId: input.projectId } }),
        ctx.prisma.customField.findMany({
          where: { projectId: input.projectId },
          orderBy: [{ order: "asc" }, { name: "asc" }],
        }),
      ]);

      let analysis;
      try {
        analysis = analyzeImportCsv(
          input.csv,
          customFields,
          input.mapping as ImportColumnMapping | undefined
        );
      } catch (error) {
        mapAnalysisLimitError(error);
      }

      if (analysis.totalRows > MAX_IMPORT_ROWS) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `CSV has ${analysis.totalRows} data rows; the maximum is ${MAX_IMPORT_ROWS}`,
        });
      }
      if (analysis.totalRows === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "CSV contains no data rows" });
      }

      const statusByName = new Map<string, StatusLike>(
        statuses.map((status) => [status.name.toLowerCase(), status])
      );
      const tagByName = new Map(tags.map((tag) => [tag.name.toLowerCase(), tag]));

      const missingStatusNames = analysis.statuses.filter(
        (name) => !statusByName.has(name.toLowerCase())
      );
      const missingTagNames = analysis.tags.filter(
        (name) => !tagByName.has(name.toLowerCase())
      );

      // Resolve assignee emails to user ids up front (case-insensitive).
      const assigneeEmails = [...new Set(analysis.data.map((row) => row.assigneeEmail).filter(Boolean))];
      const candidateUsers = assigneeEmails.length
        ? await ctx.prisma.user.findMany({
            where: { email: { in: assigneeEmails }, disabledAt: null },
            select: { id: true, email: true },
          })
        : [];
      const assigneeIdByEmail = new Map<string, string>();
      for (const user of candidateUsers) {
        if (user.email) assigneeIdByEmail.set(user.email.toLowerCase(), user.id);
      }

      // Pre-validate everything that can abort the import.
      const hardErrors: ImportIssue[] = [...analysis.issues];
      for (const row of analysis.data) {
        if (row.status && !statusByName.has(row.status.toLowerCase()) && !input.createMissing.statuses) {
          hardErrors.push({ line: row.line, message: `Unknown status "${row.status}"` });
        }
        if (!row.status && statuses.length === 0 && !(missingStatusNames.length > 0 && input.createMissing.statuses)) {
          hardErrors.push({ line: row.line, message: "Project has no workflow statuses" });
        }
      }

      if (hardErrors.length > 0) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: formatImportAbortMessage(hardErrors),
        });
      }

      // Creating missing statuses/tags requires elevated permission.
      if (missingStatusNames.length > 0 && input.createMissing.statuses) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
          permission: "workflow_manage",
        });
      }
      if (missingTagNames.length > 0 && input.createMissing.tags) {
        await requireProjectAccess(ctx.prisma, ctx.session.user.id, input.projectId, {
          permission: "workflow_manage",
        });
      }

      // Resolve assignees with project access (unresolved → unassigned).
      const unassignedAssignees: Array<{ line: number; email: string }> = [];
      const rowAssigneeIds = new Map<number, string | null>();
      for (const row of analysis.data) {
        if (!row.assigneeEmail) {
          rowAssigneeIds.set(row.line, null);
          continue;
        }
        const candidateId = assigneeIdByEmail.get(row.assigneeEmail.toLowerCase());
        const hasAccess = candidateId
          ? await canAccessProject(ctx.prisma, candidateId, input.projectId)
          : false;
        if (candidateId && hasAccess) {
          rowAssigneeIds.set(row.line, candidateId);
        } else {
          rowAssigneeIds.set(row.line, null);
          unassignedAssignees.push({ line: row.line, email: row.assigneeEmail });
        }
      }

      // Resolve participants (soft: unknown emails are ignored and reported).
      const participantEmails = [
        ...new Set(analysis.data.flatMap((row) => row.participants).filter(Boolean)),
      ];
      const participantCandidates = participantEmails.length
        ? await ctx.prisma.user.findMany({
            where: { email: { in: participantEmails }, disabledAt: null },
            select: { id: true, email: true },
          })
        : [];
      const participantIdByEmail = new Map<string, string>();
      for (const user of participantCandidates) {
        if (user.email) participantIdByEmail.set(user.email.toLowerCase(), user.id);
      }
      const rowParticipantIds = new Map<number, string[]>();
      for (const row of analysis.data) {
        const ids = row.participants
          .map((email) => participantIdByEmail.get(email.toLowerCase()))
          .filter((id): id is string => Boolean(id));
        rowParticipantIds.set(row.line, ids);
      }

      // Resolve sprints by name (soft: unknown sprints are ignored).
      const sprintNames = [...new Set(analysis.data.map((row) => row.sprint).filter(Boolean))];
      const sprints = sprintNames.length
        ? await ctx.prisma.sprint.findMany({
            where: { projectId: input.projectId, name: { in: sprintNames } },
            select: { id: true, name: true },
          })
        : [];
      const sprintIdByName = new Map(sprints.map((sprint) => [sprint.name.toLowerCase(), sprint.id]));

      const result = await ctx.prisma.$transaction(async (tx) => {
        const createdStatusNames: string[] = [];
        const createdTagNames: string[] = [];

        const nextStatusOrder =
          statuses.reduce((max, status) => Math.max(max, status.order), 0) + 1;
        for (const [index, name] of missingStatusNames.entries()) {
          const status: StatusLike = await tx.workflowStatus.create({
            data: {
              projectId: input.projectId,
              name,
              category: "todo",
              order: nextStatusOrder + index,
            },
          });
          statusByName.set(name.toLowerCase(), status);
          createdStatusNames.push(name);
        }

        for (const name of missingTagNames) {
          const tag = await tx.tag.create({
            data: {
              projectId: input.projectId,
              name,
            },
          });
          tagByName.set(name.toLowerCase(), tag);
          createdTagNames.push(name);
        }

        /**
         * Runs task creation through `createTaskWithNextNumber` while keeping
         * every row inside the single outer transaction: the wrapper routes
         * the helper's inner `$transaction` call onto the current `tx`.
         */
        const transactionalClient = {
          task: tx.task,
          $transaction: (callback: (innerTx: typeof tx) => unknown) => callback(tx),
        } as unknown as TaskNumberClient;

        let createdCount = 0;
        for (const row of analysis.data) {
          const status = row.status
            ? statusByName.get(row.status.toLowerCase())!
            : statuses[0]!;
          const tagIds = row.tags
            .map((name) => tagByName.get(name.toLowerCase())?.id)
            .filter((id): id is string => Boolean(id));
          const sprintId = row.sprint ? sprintIdByName.get(row.sprint.toLowerCase()) ?? null : null;
          const customFieldValues = row.customFields
            .map((entry) => {
              const field = customFields.find((candidate) => candidate.name === entry.name);
              if (!field) return null;
              const value = coerceCustomFieldValue(field, entry.value);
              if (value === null) return null;
              return { customFieldId: field.id, value };
            })
            .filter(
              (entry): entry is { customFieldId: string; value: string | number } => entry !== null
            );

          await createTaskWithNextNumber(
            transactionalClient,
            input.projectId,
            (tx2, taskNumber) =>
              tx2.task.create({
                data: {
                  projectId: input.projectId,
                  taskNumber,
                  title: row.title,
                  body: row.body || null,
                  statusId: status.id,
                  priority: (row.priority.toLowerCase() || "none") as
                    | "none"
                    | "low"
                    | "medium"
                    | "high"
                    | "urgent",
                  dueDate: row.dueDateRaw ? parseImportDate(row.dueDateRaw) ?? startOfToday() : startOfToday(),
                  startDate: row.startDateRaw ? parseImportDate(row.startDateRaw) ?? null : null,
                  closedAt: status.isFinal ? new Date() : null,
                  archivedAt:
                    status.autoArchive
                      ? new Date(Date.now() + (status.autoArchiveDays || 0) * 86_400_000)
                      : null,
                  creatorId: ctx.session.user.id,
                  assigneeId: rowAssigneeIds.get(row.line) ?? null,
                  sprintId,
                  ...(tagIds.length ? { tags: { create: tagIds.map((tagId) => ({ tagId })) } } : {}),
                  ...(rowParticipantIds.get(row.line)?.length
                    ? {
                        participants: {
                          create: rowParticipantIds.get(row.line)!.map((userId) => ({ userId })),
                        },
                      }
                    : {}),
                  ...(customFieldValues.length
                    ? { customFieldValues: { create: customFieldValues } }
                    : {}),
                },
              })
          );
          createdCount += 1;
        }

        return { createdCount, createdStatusNames, createdTagNames };
      });

      return {
        createdCount: result.createdCount,
        createdStatuses: result.createdStatusNames,
        createdTags: result.createdTagNames,
        unassignedAssignees,
      };
    }),
});