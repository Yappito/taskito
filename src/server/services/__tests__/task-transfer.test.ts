import { describe, expect, it } from "vitest";

import {
  analyzeImportCsv,
  autoMapHeaders,
  buildExportRecord,
  exportHeaders,
  exportRecordToCells,
  ImportLimitError,
  MAX_IMPORT_BYTES,
} from "@/server/services/task-transfer";
import { parseCsv, stringifyCsvRow } from "@/lib/csv";

function baseTask(overrides: Record<string, unknown> = {}) {
  return {
    taskNumber: 12,
    title: "Fix login bug",
    body: "Steps:\n1. open\n2. fail",
    priority: "high",
    dueDate: new Date("2026-03-01T12:00:00.000Z"),
    startDate: new Date("2026-02-01T08:00:00.000Z"),
    closedAt: null,
    archivedAt: null,
    status: { name: "In Progress" },
    project: { key: "TASK" },
    creator: { email: "creator@example.com" },
    assignee: { email: "assignee@example.com" },
    sprint: { name: "Sprint 3" },
    tags: [{ tag: { name: "backend" } }, { tag: { name: "auth" } }],
    participants: [{ user: { email: "p1@example.com" } }, { user: { email: "p2@example.com" } }],
    customFieldValues: [
      { value: 5, customField: { name: "Story Points" } },
      { value: "2026-04-01T00:00:00.000Z", customField: { name: "Review date" } },
    ],
    ...overrides,
  };
}

const CUSTOM_FIELDS = [{ name: "Story Points" }, { name: "Review date" }];

describe("export row formatting", () => {
  it("builds a flat record with ISO dates, emails, and joined lists", () => {
    const record = buildExportRecord(baseTask(), CUSTOM_FIELDS);
    expect(record).toEqual({
      key: "TASK-12",
      title: "Fix login bug",
      status: "In Progress",
      priority: "high",
      assigneeEmail: "assignee@example.com",
      creatorEmail: "creator@example.com",
      dueDate: "2026-03-01T12:00:00.000Z",
      startDate: "2026-02-01T08:00:00.000Z",
      closedAt: "",
      tags: ["backend", "auth"],
      sprint: "Sprint 3",
      participants: ["p1@example.com", "p2@example.com"],
      customFields: { "Story Points": "5", "Review date": "2026-04-01T00:00:00.000Z" },
      body: "Steps:\n1. open\n2. fail",
      archivedAt: "",
    });
  });

  it("orders cells to match the headers, including cf: columns", () => {
    const headers = exportHeaders(CUSTOM_FIELDS.map((field) => field.name));
    expect(headers).toEqual([
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
      "cf:Story Points",
      "cf:Review date",
      "Body",
      "Archived At",
    ]);

    const cells = exportRecordToCells(buildExportRecord(baseTask(), CUSTOM_FIELDS), CUSTOM_FIELDS.map((f) => f.name));
    expect(cells).toEqual([
      "TASK-12",
      "Fix login bug",
      "In Progress",
      "high",
      "assignee@example.com",
      "creator@example.com",
      "2026-03-01T12:00:00.000Z",
      "2026-02-01T08:00:00.000Z",
      "",
      "backend;auth",
      "Sprint 3",
      "p1@example.com;p2@example.com",
      "5",
      "2026-04-01T00:00:00.000Z",
      "Steps:\n1. open\n2. fail",
      "",
    ]);
    expect(headers.length).toBe(cells.length);
  });

  it("escapes bodies with newlines and commas into a valid RFC 4180 line", () => {
    const cells = exportRecordToCells(
      buildExportRecord(baseTask({ body: "multi\nline, with \"quotes\"" }), CUSTOM_FIELDS),
      CUSTOM_FIELDS.map((f) => f.name)
    );
    const rendered = stringifyCsvRow(cells);
    expect(rendered).toContain('"multi\nline, with ""quotes"""');
    // The whole record stays a single CSV record when parsed back.
    expect(parseCsv(rendered)).toHaveLength(1);
    expect(parseCsv(rendered)[0]).toEqual(cells);
  });

  it("leaves unset custom fields empty", () => {
    const record = buildExportRecord(
      baseTask({ customFieldValues: [] }),
      CUSTOM_FIELDS
    );
    expect(record.customFields).toEqual({ "Story Points": "", "Review date": "" });
  });
});

describe("import analysis", () => {
  const importFields = [
    { id: "cf1", name: "Story Points", type: "number", required: false, options: null },
    { id: "cf2", name: "Review date", type: "date", required: false, options: null },
    {
      id: "cf3",
      name: "Severity",
      type: "select",
      required: false,
      options: { choices: ["low", "high"] },
    },
  ];

  it("auto-maps headers through case-insensitive aliases", () => {
    const mapping = autoMapHeaders(
      ["Summary", "DUE DATE", "Owner (email)", "Labels", "Status", "Priority", "Description", "cf:story points", "Sprint", "Participants"],
      importFields
    );
    expect(mapping["Summary"]).toBe("title");
    expect(mapping["DUE DATE"]).toBe("dueDate");
    expect(mapping["Owner (email)"]).toBe("assigneeEmail");
    expect(mapping["Labels"]).toBe("tags");
    expect(mapping["Status"]).toBe("status");
    expect(mapping["Priority"]).toBe("priority");
    expect(mapping["Description"]).toBe("body");
    expect(mapping["cf:story points"]).toBe("cf:Story Points");
    expect(mapping["Sprint"]).toBe("sprint");
    expect(mapping["Participants"]).toBe("participants");
  });

  it("maps the first duplicate column and ignores the rest", () => {
    const mapping = autoMapHeaders(["Title", "Name"], importFields);
    expect(mapping["Title"]).toBe("title");
    expect(mapping["Name"]).toBe("ignore");
  });

  it("ignores unknown cf: columns for unknown project fields", () => {
    const mapping = autoMapHeaders(["cf:Nonexistent"], importFields);
    expect(mapping["cf:Nonexistent"]).toBe("ignore");
  });

  it("extracts row data and reports issues with line numbers", () => {
    const csv = [
      "Title,Status,Priority,Due Date,Assignee,Tags,cf:Story Points",
      "Task A,Done,high,2026-01-15,a@x.com,backend;ui,3",
      ",Done,nope,not-a-date,b@x.com,,abc",
    ].join("\r\n");

    const analysis = analyzeImportCsv(csv, importFields);
    expect(analysis.totalRows).toBe(2);
    expect(analysis.data[0]).toMatchObject({
      line: 2,
      title: "Task A",
      status: "Done",
      priority: "high",
      tags: ["backend", "ui"],
    });
    expect(analysis.data[0].customFields).toEqual([{ name: "Story Points", value: "3" }]);
    expect(analysis.issues.map((issue) => `${issue.line}: ${issue.message}`)).toEqual([
      "3: Title is required",
      '3: Priority "nope" is not one of none, low, medium, high, urgent',
      '3: Due date "not-a-date" is not a valid date (use YYYY-MM-DD or ISO 8601)',
      '3: Custom field "Story Points" requires a numeric value',
    ]);
    expect(analysis.statuses).toEqual(["Done"]);
    expect(analysis.tags).toEqual(["backend", "ui"]);
  });

  it("reports select choice violations and respects a provided mapping", () => {
    const csv = 'Title,Custom\r\nTask 1,low\r\nTask 2,bogus\r\n';
    const analysis = analyzeImportCsv(csv, importFields, { Title: "title", Custom: "cf:Severity" });
    expect(analysis.mapping.Custom).toBe("cf:Severity");
    expect(analysis.issues).toEqual([
      { line: 3, message: 'Custom field "Severity" requires one of the configured choices' },
    ]);
  });

  it("flags unknown mapping targets and ignores them", () => {
    const csv = "Title,Mystery\r\nTask 1,x\r\n";
    const analysis = analyzeImportCsv(csv, importFields, { Title: "title", Mystery: "cf:Nope" });
    expect(analysis.mapping.Mystery).toBe("ignore");
    expect(analysis.issues[0]).toMatchObject({ line: 1 });
    expect(analysis.data[0].title).toBe("Task 1");
  });

  it("skips blank rows while keeping real line numbers", () => {
    const csv = "Title\r\nTask 1\r\n\r\n\r\nTask 2\r\n";
    const analysis = analyzeImportCsv(csv, importFields);
    expect(analysis.totalRows).toBe(2);
    expect(analysis.data.map((row) => row.line)).toEqual([2, 5]);
  });

  it("caps the preview at 20 rows", () => {
    const rows = ["Title"];
    for (let index = 1; index <= 25; index += 1) rows.push(`Task ${index}`);
    const analysis = analyzeImportCsv(rows.join("\n"), importFields);
    expect(analysis.rows).toHaveLength(20);
    expect(analysis.totalRows).toBe(25);
  });

  it("rejects oversized payloads and row counts via ImportLimitError", () => {
    expect(() => analyzeImportCsv("x".repeat(MAX_IMPORT_BYTES + 1), importFields)).toThrow(ImportLimitError);
    expect(() => analyzeImportCsv('"unterminated', importFields)).toThrow(ImportLimitError);
    expect(() => analyzeImportCsv("", importFields)).toThrow(ImportLimitError);
  });
});
