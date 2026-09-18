"use client";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button, Input, Select, Alert } from "@/components/ui";

export function JiraSettings() {
  const utils = trpc.useUtils();
  const connection = trpc.jira.connection.useQuery();
  const projects = trpc.project.list.useQuery();
  const workflow = trpc.workflow.statuses.useQuery(
    { projectId: connection.data?.projectId ?? "" },
    { enabled: Boolean(connection.data?.projectId) },
  );
  const [message, setMessage] = useState("");
  const save = trpc.jira.save.useMutation({
    onSuccess: () => {
      utils.jira.invalidate();
      setMessage("Connection verified and saved. Automatic sync is scheduled.");
    },
    onError: (e) => setMessage(e.message),
  });
  const sync = trpc.jira.sync.useMutation({
    onSuccess: (result) => {
      utils.jira.invalidate();
      utils.task.invalidate();
      setMessage(
        result
          ? `Sync finished: ${result.imported} tickets processed${result.errors ? `, ${result.errors} errors` : ""}.`
          : "A sync is already running.",
      );
    },
    onError: (e) => setMessage(e.message),
  });
  const disconnect = trpc.jira.disconnect.useMutation({
    onSuccess: () => {
      utils.jira.invalidate();
      setMessage("Disconnected. Imported tasks and comments were retained.");
    },
    onError: (e) => setMessage(e.message),
  });
  if (connection.isLoading) return <p>Loading Jira settings…</p>;
  const current = connection.data;
  return (
    <section className="space-y-4 max-w-2xl">
      <h2 className="text-lg font-semibold">Jira Cloud</h2>
      <p className="text-sm">
        Sync unresolved tickets assigned to you or listing you as a request
        participant. Choose the Taskito project that will receive them. Each
        imported task gets a Jira project tag.
      </p>
      <p className="text-sm">
        Taskito project members can read imported content, including internal
        comments. Public comments and their attachments are shared with
        customers in Jira; internal comments remain internal in Jira Service
        Management.
      </p>
      {message && <Alert>{message}</Alert>}
      {current?.lastError && (
        <Alert variant="danger">{current.lastError}</Alert>
      )}
      {current && !current.participantFieldId && (
        <Alert>
          Request participants field was not found. Only assigned tickets will
          be discovered until you configure the field below.
        </Alert>
      )}
      <form
        key={`${current?.id}-${current?.siteUrl}`}
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          save.mutate({
            statusMapping: Object.fromEntries(
              [...data.entries()]
                .filter(
                  ([key, value]) =>
                    key.startsWith("status:") && String(value).trim(),
                )
                .map(([key, value]) => [key.slice(7), String(value).trim()]),
            ),
            siteUrl: String(data.get("siteUrl")),
            email: String(data.get("email")),
            apiToken: String(data.get("apiToken") || "") || undefined,
            projectId: String(data.get("projectId")),
            intervalMinutes: Number(data.get("intervalMinutes")),
            defaultDueDays: Number(data.get("defaultDueDays")),
            participantFieldId:
              String(data.get("participantFieldId") || "") || undefined,
            enabled: data.get("enabled") === "on",
          });
        }}
      >
        <label className="block text-sm">
          Jira site
          <Input
            name="siteUrl"
            type="url"
            required
            placeholder="https://your-team.atlassian.net"
            defaultValue={current?.siteUrl}
          />
        </label>
        <label className="block text-sm">
          Atlassian account email
          <Input
            name="email"
            type="email"
            required
            defaultValue={current?.email}
          />
        </label>
        <label className="block text-sm">
          API token
          <Input
            name="apiToken"
            type="password"
            autoComplete="new-password"
            required={!current}
            placeholder={
              current
                ? "Leave blank to keep saved token"
                : "Your Jira API token"
            }
          />
        </label>
        <p className="text-xs">
          Use an Atlassian API token without scopes for this site. Tokens are
          encrypted and never sent back to the browser.
        </p>
        <label className="block text-sm">
          Import into Taskito project
          <Select
            name="projectId"
            defaultValue={current?.projectId ?? ""}
            required
          >
            <option value="" disabled>
              Select project
            </option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </label>
        <label className="block text-sm">
          Poll every (minutes)
          <Input
            name="intervalMinutes"
            type="number"
            min={1}
            max={1440}
            defaultValue={current?.intervalMinutes ?? 5}
            required
          />
        </label>
        <label className="block text-sm">
          When Jira has no due date, set a Taskito due date this many days after
          import
          <Input
            name="defaultDueDays"
            type="number"
            min={1}
            max={3650}
            defaultValue={current?.defaultDueDays ?? 7}
            required
          />
        </label>
        <label className="block text-sm">
          Request participants field (auto-detected when blank)
          <Input
            name="participantFieldId"
            placeholder="customfield_10002"
            defaultValue={current?.participantFieldId ?? ""}
            pattern="customfield_[0-9]+"
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={current?.enabled ?? true}
          />{" "}
          Enable Jira sync
        </label>
        {current && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">
              Status mapping (optional)
            </legend>
            <p className="text-xs">
              Map each Taskito status to a Jira status name. Blank uses the
              Taskito name. Jira must allow the transition for your account.
            </p>
            {workflow.data?.map((status) => (
              <label key={status.id} className="block text-sm">
                {status.name}
                <Input
                  name={`status:${status.id}`}
                  placeholder={status.name}
                  defaultValue={
                    (current.statusMapping as Record<string, string>)?.[
                      status.id
                    ] ?? ""
                  }
                />
              </label>
            ))}
          </fieldset>
        )}
        <p className="text-xs">
          Titles, descriptions, due dates, and statuses sync both ways. Pending
          Taskito edits are delivered before importing Jira changes. Choose the
          destination Jira project and issue type when creating each task.
        </p>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Verifying…" : "Verify and save"}
        </Button>
      </form>
      {current && (
        <div className="space-y-3">
          <p className="text-sm">
            Last sync:{" "}
            {current.lastSyncedAt
              ? new Date(current.lastSyncedAt).toLocaleString()
              : "Not yet synced"}
          </p>
          <div className="flex gap-2">
            <Button
              disabled={sync.isPending || !current.enabled}
              onClick={() => sync.mutate()}
            >
              {sync.isPending ? "Syncing…" : "Sync now"}
            </Button>
            <Button
              variant="outline"
              disabled={disconnect.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Disconnect Jira? Tasks and comments remain in Taskito, but their Jira links and stored token will be removed.",
                  )
                )
                  disconnect.mutate();
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
