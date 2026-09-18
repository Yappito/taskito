import { decryptSecret } from "@/lib/secret-crypto";

export type JiraDocument = {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JiraDocument[];
};
export function jiraText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as JiraDocument;
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return String(node.attrs?.text ?? "@user");
  const text = node.text ?? node.content?.map(jiraText).join("") ?? "";
  return [
    "paragraph",
    "heading",
    "listItem",
    "blockquote",
    "codeBlock",
  ].includes(node.type ?? "")
    ? `${text}\n`
    : text;
}
export function jiraDocument(text: string) {
  return {
    type: "doc",
    version: 1,
    content: text
      .split("\n")
      .map((line) => ({
        type: "paragraph",
        content: line ? [{ type: "text", text: line }] : [],
      })),
  };
}
export function normalizeJiraSite(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !/^[a-z0-9][a-z0-9-]*\.atlassian\.net$/.test(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Enter a Jira Cloud site URL such as https://your-team.atlassian.net",
    );
  }
  return url.origin;
}
export class JiraApiError extends Error {
  constructor(
    public status: number,
    public retryAfter: number = 60,
    details = "",
  ) {
    super(
      `Jira returned HTTP ${status}. ${status === 401 ? "Check your email and API token." : status === 403 ? "Your Jira account lacks permission for this operation." : status === 429 ? "Rate limited; sync will retry later." : "Check Jira permissions and required fields."}${details ? ` ${details}` : ""}`,
    );
  }
}
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content: string;
}
export interface JiraComment {
  id: string;
  body: unknown;
  public?: boolean;
  author?: { displayName?: string };
  created?: string | { iso8601: string };
  properties?: Array<{ key: string; value: unknown }>;
  visibility?: unknown;
  _expanded?: {
    attachment?: {
      values: Array<{
        id: string;
        filename: string;
        mimeType: string;
        size: number;
        _links: { content: string };
      }>;
    };
  };
}
export interface JiraIssueData {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: unknown;
    duedate?: string;
    created: string;
    updated: string;
    resolution?: unknown;
    assignee?: { accountId: string };
    project: { key: string; name: string; projectTypeKey?: string };
    status: { name: string; statusCategory: { key: string } };
    priority?: { name: string };
    attachment?: JiraAttachment[];
    [key: string]: unknown;
  };
}
export class JiraClient {
  readonly site: string;
  private authorization: string;
  constructor(
    connection: { siteUrl: string; email: string; encryptedApiToken: string },
    private signal?: AbortSignal,
  ) {
    this.site = normalizeJiraSite(connection.siteUrl);
    this.authorization = `Basic ${Buffer.from(`${connection.email}:${decryptSecret(connection.encryptedApiToken)}`).toString("base64")}`;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (!path.startsWith("/rest/")) throw new Error("Invalid Jira API path");
    const response = await fetch(this.site + path, {
      ...init,
      redirect: "error",
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        Authorization: this.authorization,
        Accept: "application/json",
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      const details =
        response.status === 400
          ? ((await response.json().catch(() => ({}))) as {
              errorMessages?: string[];
              errors?: Record<string, string>;
            })
          : {};
      throw new JiraApiError(
        response.status,
        Number(response.headers.get("retry-after")) || 60,
        [
          ...(details.errorMessages ?? []),
          ...Object.entries(details.errors ?? {}).map(
            ([field, message]) => `${field}: ${message}`,
          ),
        ]
          .join("; ")
          .slice(0, 1000),
      );
    }
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T);
  }
  async *search(jql: string): AsyncGenerator<JiraIssueData> {
    let nextPageToken: string | undefined;
    do {
      const page = await this.request<{
        issues: JiraIssueData[];
        nextPageToken?: string;
        isLast?: boolean;
      }>("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql,
          maxResults: 100,
          fields: [
            "project",
            "summary",
            "description",
            "duedate",
            "created",
            "updated",
            "resolution",
            "assignee",
            "status",
            "priority",
            "attachment",
          ],
          nextPageToken,
        }),
      });
      for (const issue of page.issues) yield issue;
      if (page.isLast || !page.nextPageToken) break;
      if (nextPageToken === page.nextPageToken)
        throw new Error("Jira search pagination did not advance");
      nextPageToken = page.nextPageToken;
    } while (nextPageToken);
  }
  async pages<T>(
    path: string,
    property: "values" | "comments" | "issueTypes",
    serviceDesk = false,
  ): Promise<T[]> {
    const result: T[] = [];
    let start = 0;
    for (;;) {
      const page = await this.request<Record<string, unknown>>(
        path +
          (path.includes("?") ? "&" : "?") +
          (serviceDesk
            ? `start=${start}&limit=100`
            : `startAt=${start}&maxResults=100`),
      );
      const values = page[property] as T[];
      if (!Array.isArray(values))
        throw new Error("Unexpected Jira pagination response");
      result.push(...values);
      start += values.length;
      if (
        !values.length ||
        page.isLastPage === true ||
        page.isLast === true ||
        (typeof page.total === "number" && start >= page.total)
      )
        return result;
      if (!serviceDesk && page.total === undefined && values.length < 100)
        return result;
    }
  }
  async requestInfo(key: string) {
    try {
      return await this.request<{ serviceDeskId: string }>(
        `/rest/servicedeskapi/request/${encodeURIComponent(key)}`,
      );
    } catch (error) {
      if (error instanceof JiraApiError && error.status === 404) return null;
      throw error;
    }
  }
  async download(id: string): Promise<Uint8Array> {
    // Jira's endpoint redirects to its signed media URL; fetch strips the
    // Authorization header on cross-origin redirects. Never fetch URLs from text.
    const response = await fetch(
      `${this.site}/rest/api/3/attachment/content/${encodeURIComponent(id)}`,
      {
        headers: { Authorization: this.authorization },
        signal: this.signal
          ? AbortSignal.any([this.signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
      },
    );
    if (!response.ok) throw new JiraApiError(response.status);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty Jira attachment response");
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > 20 * 1024 * 1024)
          throw new Error("Jira attachment exceeds Taskito's 20MB limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks);
  }
  async upload(path: string, name: string, bytes: Uint8Array) {
    const data = new FormData();
    data.append("file", new Blob([new Uint8Array(bytes)]), name);
    return this.request<unknown>(path, {
      method: "POST",
      headers: { "X-Atlassian-Token": "no-check" },
      body: data,
    });
  }
}
export function assignedIssueJql(participantFieldId: string | null) {
  if (participantFieldId && !/^customfield_\d+$/.test(participantFieldId))
    throw new Error("Invalid participant field ID");
  const participants = participantFieldId
    ? ` OR cf[${participantFieldId.slice(12)}] = currentUser()`
    : "";
  return `(assignee = currentUser()${participants}) AND resolution = Unresolved AND statusCategory != Done ORDER BY updated ASC, key ASC`;
}
