import { parseCsvRecords, type CsvRecord } from "@/lib/csv";

/**
 * Shared logic for the CSV/JSON task export route and the CSV import tRPC
 * procedures. This module is framework-free on purpose: it never touches the
 * Prisma client, so export row formatting and import analysis can be unit
 * tested in isolation.
 */

// ─── Limits ──────────────────────────────────────────────

/** Maximum accepted CSV payload for import (2 MB). */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
/** Maximum number of data rows (excluding the header) accepted per import. */
export const MAX_IMPORT_ROWS = 5000;
/** Number of rows returned in the import preview. */
export const IMPORT_PREVIEW_ROWS = 20;
/** Batch size used by the streaming export route. */
export const EXPORT_BATCH_SIZE = 200;

// ─── Export row building ─────────────────────────────────

const EXPORT_BASE_HEADERS = [
  "Key",
  "Title",
  "Status",
  "Priority",
  "Assignee",
  "Creator",
  "Due Date",
  "Start Date",
  "Closed At",
  "Tags",
  "Sprint",
  "Participants",
] as const;

/** Structural shape of a task row as fetched by the export route. */
export interface ExportTaskRow {
  taskNumber: number;
  title: string;
  body: string | null;
  priority: string;
  dueDate: Date;
  startDate: Date | null;
  closedAt: Date | null;
  archivedAt: Date | null;
  status: { name: string } | null;
  project: { key: string };
  creator: { email: string | null } | null;
  assignee: { email: string | null } | null;
  sprint: { name: string } | null;
  tags: Array<{ tag: { name: string } }>;
  participants: Array<{ user: { email: string | null } }>;
  customFieldValues: Array<{ value: unknown; customField: { name: string } | null }>;
}

export interface ExportTaskRecord {
  key: string;
  title: string;
  status: string;
  priority: string;
  assigneeEmail: string;
  creatorEmail: string;
  dueDate: string;
  startDate: string;
  closedAt: string;
  tags: string[];
  sprint: string;
  participants: string[];
  /** Custom field value per project field name (empty string when unset). */
  customFields: Record<string, string>;
  body: string;
  archivedAt: string;
}

function toIso(value: Date | null | undefined): string {
  return value ? new Date(value).toISOString() : "";
}

function formatCustomFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isNaN(value) ? "" : String(value);
  if (typeof value === "string") return value;
  return "";
}

/** Header row for a CSV export; custom field columns are prefixed with `cf:`. */
export function exportHeaders(customFieldNames: string[]): string[] {
  return [
    ...EXPORT_BASE_HEADERS,
    ...customFieldNames.map((name) => `cf:${name}`),
    "Body",
    "Archived At",
  ];
}

/** Maps a fetched task row onto the flat export record. */
export function buildExportRecord(
  task: ExportTaskRow,
  customFields: Array<{ name: string }>
): ExportTaskRecord {
  const valuesByFieldName = new Map<string, string>();
  for (const entry of task.customFieldValues ?? []) {
    const name = entry.customField?.name;
    if (!name) continue;
    const formatted = formatCustomFieldValue(entry.value);
    if (formatted !== "") {
      valuesByFieldName.set(name, formatted);
    }
  }

  return {
    key: `${task.project.key}-${task.taskNumber}`,
    title: task.title,
    status: task.status?.name ?? "",
    priority: task.priority ?? "none",
    assigneeEmail: task.assignee?.email ?? "",
    creatorEmail: task.creator?.email ?? "",
    dueDate: toIso(task.dueDate),
    startDate: toIso(task.startDate),
    closedAt: toIso(task.closedAt),
    tags: (task.tags ?? []).map((entry) => entry.tag.name).filter(Boolean),
    sprint: task.sprint?.name ?? "",
    participants: (task.participants ?? [])
      .map((entry) => entry.user.email ?? "")
      .filter(Boolean),
    customFields: Object.fromEntries(
      customFields.map((field) => [field.name, valuesByFieldName.get(field.name) ?? ""])
    ),
    body: task.body ?? "",
    archivedAt: toIso(task.archivedAt),
  };
}

/** Flattens an export record into cells ordered like {@link exportHeaders}. */
export function exportRecordToCells(
  record: ExportTaskRecord,
  customFieldNames: string[]
): string[] {
  return [
    record.key,
    record.title,
    record.status,
    record.priority,
    record.assigneeEmail,
    record.creatorEmail,
    record.dueDate,
    record.startDate,
    record.closedAt,
    record.tags.join(";"),
    record.sprint,
    record.participants.join(";"),
    ...customFieldNames.map((name) => record.customFields[name] ?? ""),
    record.body,
    record.archivedAt,
  ];
}

// ─── Import: headers & mapping ───────────────────────────

export const IMPORT_FIELD_KEYS = [
  "title",
  "status",
  "priority",
  "dueDate",
  "startDate",
  "assigneeEmail",
  "tags",
  "sprint",
  "participants",
  "body",
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELD_KEYS)[number];

/** Any mapping value: a field key, `cf:<Custom Field Name>`, or `ignore`. */
export type ImportMappingTarget = ImportFieldKey | "ignore" | (string & {});

/** Column header text mapped onto an import target. */
export type ImportColumnMapping = Record<string, ImportMappingTarget>;

const HEADER_ALIASES: Record<string, ImportFieldKey | "ignore"> = {
  title: "title",
  summary: "title",
  name: "title",
  status: "status",
  priority: "priority",
  due: "dueDate",
  duedate: "dueDate",
  start: "startDate",
  startdate: "startDate",
  assignee: "assigneeEmail",
  assigneemail: "assigneeEmail",
  owner: "assigneeEmail",
  owneremail: "assigneeEmail",
  tags: "tags",
  labels: "tags",
  sprint: "sprint",
  participants: "participants",
  description: "body",
  body: "body",
  // Export-only informational columns.
  key: "ignore",
  taskkey: "ignore",
  creator: "ignore",
  creatoremail: "ignore",
  closedat: "ignore",
  closed: "ignore",
  archivedat: "ignore",
};

export function normalizeImportHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

const PRIORITIES = new Set(["none", "low", "medium", "high", "urgent"]);

/**
 * Parses a date cell. Accepts ISO 8601 timestamps and plain `YYYY-MM-DD`
 * dates; returns null when the value cannot be parsed.
 */
export function parseImportDate(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    const parsed = new Date(Date.UTC(year!, month! - 1, day!));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveCustomFieldName(
  target: string,
  customFields: Array<{ name: string }>
): string | null {
  const cfName = target.slice(3);
  const normalized = normalizeImportHeader(cfName);
  const match = customFields.find(
    (field) => normalizeImportHeader(field.name) === normalized
  );
  return match ? match.name : null;
}

function isKnownTarget(
  target: string,
  customFields: Array<{ name: string }>
): boolean {
  if (target === "ignore") return true;
  if ((IMPORT_FIELD_KEYS as readonly string[]).includes(target)) return true;
  return target.startsWith("cf:") && resolveCustomFieldName(target, customFields) !== null;
}

/** Builds a default header → target mapping using case-insensitive aliases. */
export function autoMapHeaders(
  headers: string[],
  customFields: Array<{ name: string }>
): ImportColumnMapping {
  const cfByNormalized = new Map(
    customFields.map((field) => [normalizeImportHeader(field.name), field.name])
  );
  const usedTargets = new Set<string>();
  const mapping: ImportColumnMapping = {};

  for (const header of headers) {
    const trimmed = header.trim();
    if (/^cf:/i.test(trimmed)) {
      const match = cfByNormalized.get(normalizeImportHeader(trimmed.slice(3)));
      const target = match && !usedTargets.has(`cf:${match}`) ? `cf:${match}` : "ignore";
      mapping[header] = target;
      if (target !== "ignore") usedTargets.add(target);
      continue;
    }
    const alias = HEADER_ALIASES[normalizeImportHeader(trimmed)] ?? "ignore";
    const target = alias !== "ignore" && usedTargets.has(alias) ? "ignore" : alias;
    mapping[header] = target;
    if (target !== "ignore") usedTargets.add(target);
  }

  return mapping;
}

// ─── Import: analysis ────────────────────────────────────

export interface ImportIssue {
  line: number;
  message: string;
}

export interface ImportRowData {
  line: number;
  title: string;
  status: string;
  priority: string;
  dueDateRaw: string;
  startDateRaw: string;
  assigneeEmail: string;
  tags: string[];
  sprint: string;
  participants: string[];
  body: string;
  customFields: Array<{ name: string; value: string }>;
}

export class ImportLimitError extends Error {}

export interface ImportAnalysis {
  columns: string[];
  mapping: ImportColumnMapping;
  /** Raw preview rows (header excluded), capped at {@link IMPORT_PREVIEW_ROWS}. */
  rows: CsvRecord[];
  /** Number of data rows that will be imported (blank rows skipped). */
  totalRows: number;
  data: ImportRowData[];
  issues: ImportIssue[];
  /** Distinct status names referenced by the rows, in first-seen order. */
  statuses: string[];
  /** Distinct tag names referenced by the rows, in first-seen order. */
  tags: string[];
  /** Assignee email candidates with the lines that reference them. */
  assigneeReferences: Array<{ line: number; email: string }>;
}

function splitImportList(value: string): string[] {
  return value
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateSelectChoices(field: { name: string; options: unknown }, value: string): boolean {
  const choices = Array.isArray((field.options as { choices?: unknown } | null)?.choices)
    ? ((field.options as { choices?: unknown[] }).choices as unknown[]).filter(
        (choice): choice is string => typeof choice === "string"
      )
    : [];
  return choices.length === 0 || choices.includes(value);
}

/**
 * Parses and validates an import CSV against the project's custom fields.
 *
 * Pure function: it does not consult the database. Cross-references against
 * existing statuses/tags/assignees are performed by the caller (router), which
 * appends its own issues.
 */
export function analyzeImportCsv(
  csv: string,
  customFields: Array<{ id: string; name: string; type: string; required: boolean; options: unknown }>,
  providedMapping?: ImportColumnMapping
): ImportAnalysis {
  if (csv.length > MAX_IMPORT_BYTES) {
    throw new ImportLimitError(`CSV exceeds the ${MAX_IMPORT_BYTES / (1024 * 1024)} MB import limit`);
  }

  let records: CsvRecord[];
  try {
    records = parseCsvRecords(csv);
  } catch (error) {
    throw new ImportLimitError(
      error instanceof Error ? error.message : "Could not parse the CSV file"
    );
  }

  if (records.length === 0) {
    throw new ImportLimitError("CSV file is empty");
  }

  const columns = records[0]!.cells.map((cell) => cell.trim());
  const mapping: ImportColumnMapping =
    providedMapping && Object.keys(providedMapping).length > 0
      ? { ...providedMapping }
      : autoMapHeaders(columns, customFields);

  // Fill targets for unmapped columns and flag unknown mapping targets.
  const issues: ImportIssue[] = [];
  for (const column of columns) {
    const target = mapping[column] ?? "ignore";
    if (target !== "ignore" && !isKnownTarget(target, customFields)) {
      issues.push({
        line: 1,
        message: `Column "${column}" is mapped to unknown target "${target}" and will be ignored`,
      });
      mapping[column] = "ignore";
    } else {
      mapping[column] = target;
    }
  }

  // Resolve cf: targets to canonical project field names once.
  const columnTargets = new Map<string, { kind: ImportFieldKey | "customField"; cfName: string | null }>();
  for (const column of columns) {
    const target = mapping[column];
    if (!target || target === "ignore") continue;
    if (target.startsWith("cf:")) {
      const cfName = resolveCustomFieldName(target, customFields);
      if (!cfName) continue;
      columnTargets.set(column, { kind: "customField", cfName });
      continue;
    }
    columnTargets.set(column, { kind: target as ImportFieldKey, cfName: null });
  }

  const dataRows = records.slice(1).filter((record) => record.cells.some((cell) => cell !== ""));
  if (dataRows.length > MAX_IMPORT_ROWS) {
    throw new ImportLimitError(`CSV has ${dataRows.length} data rows; the maximum is ${MAX_IMPORT_ROWS}`);
  }

  const issuesByLineKey = new Set<string>();
  const addIssue = (line: number, message: string) => {
    const key = `${line}:${message}`;
    if (issuesByLineKey.has(key)) return;
    issuesByLineKey.add(key);
    issues.push({ line, message });
  };

  const statusesSeen = new Set<string>();
  const tagsSeen = new Set<string>();
  const assigneeSeen = new Map<string, { email: string; lines: number[] }>();
  const data: ImportRowData[] = [];

  for (const record of dataRows) {
    const row: ImportRowData = {
      line: record.line,
      title: "",
      status: "",
      priority: "",
      dueDateRaw: "",
      startDateRaw: "",
      assigneeEmail: "",
      tags: [],
      sprint: "",
      participants: [],
      body: "",
      customFields: [],
    };

    record.cells.forEach((cell, index) => {
      const column = columns[index];
      if (column === undefined) return;
      const target = columnTargets.get(column);
      if (!target) return;

      if (target.cfName) {
        if (cell !== "") {
          row.customFields.push({ name: target.cfName, value: cell });
        }
        return;
      }

      switch (target.kind) {
        case "title":
          row.title = cell.trim();
          break;
        case "status":
          row.status = cell.trim();
          break;
        case "priority":
          row.priority = cell.trim();
          break;
        case "dueDate":
          row.dueDateRaw = cell.trim();
          break;
        case "startDate":
          row.startDateRaw = cell.trim();
          break;
        case "assigneeEmail":
          row.assigneeEmail = cell.trim();
          break;
        case "tags":
          row.tags = splitImportList(cell);
          break;
        case "sprint":
          row.sprint = cell.trim();
          break;
        case "participants":
          row.participants = splitImportList(cell);
          break;
        case "body":
          row.body = cell;
          break;
      }
    });

    // Row-level validation issues (hard errors on commit).
    if (!row.title) {
      addIssue(record.line, "Title is required");
    }
    if (row.priority && !PRIORITIES.has(row.priority.toLowerCase())) {
      addIssue(record.line, `Priority "${row.priority}" is not one of none, low, medium, high, urgent`);
    }
    if (row.dueDateRaw && !parseImportDate(row.dueDateRaw)) {
      addIssue(record.line, `Due date "${row.dueDateRaw}" is not a valid date (use YYYY-MM-DD or ISO 8601)`);
    }
    if (row.startDateRaw && !parseImportDate(row.startDateRaw)) {
      addIssue(record.line, `Start date "${row.startDateRaw}" is not a valid date (use YYYY-MM-DD or ISO 8601)`);
    }
    for (const entry of row.customFields) {
      const field = customFields.find((candidate) => candidate.name === entry.name);
      if (!field) continue;
      if (field.type === "number" && Number.isNaN(Number(entry.value))) {
        addIssue(record.line, `Custom field "${field.name}" requires a numeric value`);
      } else if (field.type === "date" && !parseImportDate(entry.value)) {
        addIssue(record.line, `Custom field "${field.name}" requires a valid date value`);
      } else if (field.type === "select" && !validateSelectChoices(field, entry.value)) {
        addIssue(record.line, `Custom field "${field.name}" requires one of the configured choices`);
      }
    }

    if (row.status) statusesSeen.add(row.status);
    for (const tag of row.tags) tagsSeen.add(tag);
    if (row.assigneeEmail) {
      const key = row.assigneeEmail.toLowerCase();
      const seen = assigneeSeen.get(key) ?? { email: row.assigneeEmail, lines: [] };
      seen.lines.push(record.line);
      assigneeSeen.set(key, seen);
    }

    data.push(row);
  }

  return {
    columns,
    mapping,
    rows: dataRows.slice(0, IMPORT_PREVIEW_ROWS),
    totalRows: data.length,
    data,
    issues,
    statuses: [...statusesSeen],
    tags: [...tagsSeen],
    assigneeReferences: [...assigneeSeen.values()].map((seen) => ({
      line: seen.lines[0]!,
      email: seen.email,
    })),
  };
}

/** Formats a hard-abort error message listing every offending line. */
export function formatImportAbortMessage(hardErrors: ImportIssue[]): string {
  const details = hardErrors.map((issue) => `line ${issue.line}: ${issue.message}`).join("; ");
  return `Import aborted, nothing was committed (${details})`;
}
