"use client";

import { use, useEffect, useMemo, useState } from "react";
import { Download, FileUp } from "lucide-react";
import { trpc } from "@/lib/trpc-client";
import { Alert, Button, Select } from "@/components/ui";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const EXPORT_FORMATS = [
  { value: "csv", label: "CSV (Excel-friendly)" },
  { value: "json", label: "JSON" },
] as const;

/** Project settings → Import / Export page. */
export default function ImportExportSettingsPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = use(params);
  const { data: project } = trpc.project.bySlug.useQuery({ slug: projectSlug });

  if (!project) {
    return <div className="p-8" style={{ color: "var(--color-text-muted)" }}>Loading...</div>;
  }

  return <ImportExportContent projectSlug={projectSlug} projectId={project.id} />;
}

function ImportExportContent({ projectSlug, projectId }: { projectSlug: string; projectId: string }) {
  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 lg:px-6">
      <div
        className="rounded-3xl border p-6"
        style={{
          borderColor: "var(--color-border)",
          background:
            "linear-gradient(135deg, color-mix(in srgb, var(--color-info) 10%, var(--color-surface)) 0%, var(--color-surface) 64%)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.22em]" style={{ color: "var(--color-text-muted)" }}>
          Project settings
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight" style={{ color: "var(--color-text)" }}>
          Import / Export
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Export tasks to CSV or JSON for backups and reporting, or import tasks from a CSV file.
          Imports preview every row before anything is written.
        </p>
      </div>

      <ExportCard projectSlug={projectSlug} />
      <ImportCard projectId={projectId} />
    </div>
  );
}

function ExportCard({ projectSlug }: { projectSlug: string }) {
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [query, setQuery] = useState("");

  const downloadHref = `/api/projects/${encodeURIComponent(projectSlug)}/export?format=${format}${
    query.trim() ? `&query=${encodeURIComponent(query.trim())}` : ""
  }`;

  return (
    <section
      className="rounded-3xl border p-6"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}
    >
      <div className="flex items-center gap-2">
        <Download size={18} style={{ color: "var(--color-accent)" }} />
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Export</h2>
      </div>
      <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Downloads <code>taskito-&lt;project key&gt;-&lt;date&gt;.csv</code> (or <code>.json</code>). CSV exports include a UTF-8
        BOM, RFC 4180 quoting, and one <code>cf:</code> column per custom field. Archived tasks are excluded unless the query
        filters for them.
      </p>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="Format">
          {(ids) => (
            <Select
              id={ids.id}
              value={format}
              onChange={(event) => setFormat(event.target.value === "json" ? "json" : "csv")}
            >
              {EXPORT_FORMATS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Filter query (optional)">
          {(ids) => (
            <Input
              id={ids.id}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={'e.g. status = Done AND priority in (high, urgent)'}
            />
          )}
        </Field>
      </div>

      <div className="mt-4">
        <a href={downloadHref} download>
          <Button type="button">
            <Download size={14} />
            Download {format.toUpperCase()}
          </Button>
        </a>
      </div>
    </section>
  );
}

const MAPPING_OPTIONS = [
  { value: "ignore", label: "Ignore column" },
  { value: "title", label: "Title" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "dueDate", label: "Due date" },
  { value: "startDate", label: "Start date" },
  { value: "assigneeEmail", label: "Assignee (email)" },
  { value: "tags", label: "Tags" },
  { value: "sprint", label: "Sprint" },
  { value: "participants", label: "Participants (emails)" },
  { value: "body", label: "Description / Body" },
] as const;

function ImportCard({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const { data: customFields = [] } = trpc.customField.list.useQuery({ projectId });
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [createMissing, setCreateMissing] = useState({ statuses: false, tags: false });
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitResult, setCommitResult] = useState<{
    createdCount: number;
    createdStatuses: string[];
    createdTags: string[];
    unassignedAssignees: Array<{ line: number; email: string }>;
  } | null>(null);

  const previewState = trpc.import.previewCsv.useQuery(
    { projectId, csv: csv ?? "" },
    { enabled: Boolean(csv) }
  );

  const commitMutation = trpc.import.commitCsv.useMutation({
    onSuccess: (result) => {
      setCommitError(null);
      setCommitResult(result);
      utils.dashboard.invalidate();
    },
    onError: (error) => {
      setCommitResult(null);
      setCommitError(error.message);
    },
  });

  const mappingOptions = useMemo(
    () => [
      ...MAPPING_OPTIONS,
      ...customFields.map((field) => ({ value: `cf:${field.name}`, label: `Custom field: ${field.name}` })),
    ],
    [customFields]
  );

  useEffect(() => {
    if (previewState.data) {
      setMapping(previewState.data.mapping);
      setCommitResult(null);
      setCommitError(null);
    }
  }, [previewState.data]);

  function handleFile(file: File | null) {
    setCommitResult(null);
    setCommitError(null);
    if (!file) return;
    setFileName(file.name);
    if (file.size > MAX_IMPORT_BYTES) {
      setCommitError("File is larger than the 2 MB import limit");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(typeof reader.result === "string" ? reader.result : null);
    };
    reader.readAsText(file);
  }

  function reset() {
    setCsv(null);
    setFileName("");
    setMapping({});
    setCreateMissing({ statuses: false, tags: false });
    setCommitResult(null);
    setCommitError(null);
  }

  const previewData = previewState.data;
  const hasHardIssues = (previewData?.issues.length ?? 0) > 0;

  return (
    <section
      className="rounded-3xl border p-6"
      style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)", boxShadow: "var(--shadow-sm)" }}
    >
      <div className="flex items-center gap-2">
        <FileUp size={18} style={{ color: "var(--color-accent)" }} />
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>Import</h2>
      </div>
      <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
        Upload a CSV (max 2 MB, up to 5000 rows). Review the preview and column mapping, then commit.
        A hard row error aborts the whole import — nothing is written unless every row is valid.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(event) => handleFile(event.target.files?.[0] ?? null)}
          className="text-sm"
          style={{ color: "var(--color-text)" }}
        />
        {csv && (
          <Button variant="outline" size="sm" onClick={reset}>
            Clear file
          </Button>
        )}
        {fileName && (
          <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>{fileName}</span>
        )}
      </div>

      {previewState.isLoading && (
        <p className="mt-4 text-sm" style={{ color: "var(--color-text-muted)" }}>Analyzing CSV...</p>
      )}
      {previewState.error && (
        <Alert variant="danger" className="mt-4">{previewState.error.message}</Alert>
      )}
      {commitError && <Alert variant="danger" className="mt-4">{commitError}</Alert>}

      {previewData && (
        <div className="mt-5 space-y-5">
          <p className="text-sm" style={{ color: "var(--color-text-secondary)" }}>
            {previewData.totalRows} row{previewData.totalRows === 1 ? "" : "s"} found.
            {previewData.wouldCreate.statuses.length > 0 && (
              <> New statuses would be created: <strong>{previewData.wouldCreate.statuses.join(", ")}</strong>.</>
            )}
            {previewData.wouldCreate.tags.length > 0 && (
              <> New tags would be created: <strong>{previewData.wouldCreate.tags.join(", ")}</strong>.</>
            )}
          </p>

          {previewData.issues.length > 0 && (
            <Alert variant={hasHardIssues ? "danger" : "warning"}>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {previewData.issues.map((issue, index) => (
                  <li key={index}>
                    Line {issue.line}: {issue.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )}

          {/* Column mapping */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>Column mapping</h3>
            <div className="grid gap-2 md:grid-cols-2">
              {previewData.columns.map((column) => (
                <div key={column} className="flex items-center gap-2">
                  <span className="w-40 truncate text-xs font-medium" style={{ color: "var(--color-text-secondary)" }} title={column}>
                    {column}
                  </span>
                  <Select
                    value={mapping[column] ?? "ignore"}
                    onChange={(event) =>
                      setMapping((previous) => ({ ...previous, [column]: event.target.value }))
                    }
                    className="flex-1"
                  >
                    {mappingOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {/* Preview table */}
          <div className="space-y-2">
            <h3 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>
              Preview (first {previewData.rows.length} row{previewData.rows.length === 1 ? "" : "s"})
            </h3>
            <div className="overflow-x-auto rounded-xl border" style={{ borderColor: "var(--color-border)" }}>
              <table className="w-full text-left text-xs">
                <thead>
                  <tr style={{ backgroundColor: "var(--color-bg-muted)" }}>
                    <th className="px-2 py-2" style={{ color: "var(--color-text-muted)" }}>Line</th>
                    {previewData.columns.map((column) => (
                      <th key={column} className="px-2 py-2 whitespace-nowrap" style={{ color: "var(--color-text-muted)" }}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {previewData.rows.map((row) => (
                    <tr key={row.line} className="border-t" style={{ borderColor: "var(--color-border)" }}>
                      <td className="px-2 py-1.5" style={{ color: "var(--color-text-muted)" }}>{row.line}</td>
                      {row.cells.map((cell, index) => (
                        <td
                          key={index}
                          className="max-w-48 truncate px-2 py-1.5 whitespace-nowrap"
                          style={{ color: "var(--color-text)" }}
                          title={cell}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Create missing toggles */}
          {(previewData.wouldCreate.statuses.length > 0 || previewData.wouldCreate.tags.length > 0) && (
            <div className="flex flex-wrap gap-6">
              {previewData.wouldCreate.statuses.length > 0 && (
                <label className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text)" }}>
                  <input
                    type="checkbox"
                    checked={createMissing.statuses}
                    onChange={(event) => setCreateMissing((previous) => ({ ...previous, statuses: event.target.checked }))}
                  />
                  Create missing statuses ({previewData.wouldCreate.statuses.length}) — requires workflow manage access
                </label>
              )}
              {previewData.wouldCreate.tags.length > 0 && (
                <label className="flex items-center gap-2 text-sm" style={{ color: "var(--color-text)" }}>
                  <input
                    type="checkbox"
                    checked={createMissing.tags}
                    onChange={(event) => setCreateMissing((previous) => ({ ...previous, tags: event.target.checked }))}
                  />
                  Create missing tags ({previewData.wouldCreate.tags.length}) — requires workflow manage access
                </label>
              )}
            </div>
          )}

          {/* Commit */}
          <div className="flex items-center gap-3">
            <Button
              onClick={() =>
                commitMutation.mutate({ projectId, csv: csv!, mapping, createMissing })
              }
              disabled={hasHardIssues || commitMutation.isPending || previewData.totalRows === 0}
            >
              {commitMutation.isPending ? "Importing..." : `Import ${previewData.totalRows} tasks`}
            </Button>
            {!hasHardIssues && previewData.totalRows > 0 && (
              <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                Everything looks good — nothing has been imported yet.
              </span>
            )}
          </div>

          {commitResult && (
            <Alert variant="success">
              Imported {commitResult.createdCount} task{commitResult.createdCount === 1 ? "" : "s"}.
              {commitResult.createdStatuses.length > 0 && <> Created statuses: {commitResult.createdStatuses.join(", ")}.</>}
              {commitResult.createdTags.length > 0 && <> Created tags: {commitResult.createdTags.join(", ")}.</>}
              {commitResult.unassignedAssignees.length > 0 && (
                <> {commitResult.unassignedAssignees.length} row{commitResult.unassignedAssignees.length === 1 ? "" : "s"} left unassigned (unknown assignee email).</>
              )}
            </Alert>
          )}
        </div>
      )}
    </section>
  );
}
