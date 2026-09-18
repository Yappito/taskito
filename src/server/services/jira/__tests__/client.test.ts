import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "@/lib/secret-crypto";
import {
  assignedIssueJql,
  JiraApiError,
  JiraClient,
  jiraDocument,
  jiraText,
  normalizeJiraSite,
} from "../client";

beforeEach(() =>
  vi.stubEnv("AI_SECRET_MASTER_KEY", Buffer.alloc(32, 7).toString("base64")),
);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
const connection = () => ({
  siteUrl: "https://team.atlassian.net",
  email: "person@example.com",
  encryptedApiToken: encryptSecret("secret-token"),
});
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });

describe("Jira Cloud client", () => {
  it("only accepts tenant origins, rejecting SSRF and credential-bearing URLs", () => {
    expect(normalizeJiraSite("https://team.atlassian.net/")).toBe(
      "https://team.atlassian.net",
    );
    for (const site of [
      "http://team.atlassian.net",
      "https://localhost",
      "https://team.atlassian.net.evil.test",
      "https://team.atlassian.net:444",
      "https://user:pass@team.atlassian.net",
      "https://team.atlassian.net/rest/api",
      "https://team.atlassian.net?foo=1",
    ])
      expect(() => normalizeJiraSite(site)).toThrow();
  });
  it("groups assignee and participant predicates before applying closure filters", () => {
    expect(assignedIssueJql("customfield_10002")).toBe(
      "(assignee = currentUser() OR cf[10002] = currentUser()) AND resolution = Unresolved AND statusCategory != Done ORDER BY updated ASC, key ASC",
    );
    expect(assignedIssueJql(null)).not.toContain(" OR ");
    expect(() =>
      assignedIssueJql("customfield_1] OR project=SECRET"),
    ).toThrow();
  });
  it("round-trips multiline text through ADF and preserves mention labels", () => {
    expect(jiraText(jiraDocument("one\ntwo")).trim()).toBe("one\ntwo");
    expect(
      jiraText({
        type: "paragraph",
        content: [
          { type: "mention", attrs: { text: "@Jane" } },
          { type: "hardBreak" },
          { type: "text", text: "Hi" },
        ],
      }),
    ).toBe("@Jane\nHi\n");
  });
  it("follows enhanced-search pagination and authenticates without following API redirects", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ issues: [{ id: "1" }], nextPageToken: "page-two" }),
      )
      .mockResolvedValueOnce(json({ issues: [{ id: "2" }], isLast: true }));
    vi.stubGlobal("fetch", fetcher);
    const issues = [];
    for await (const issue of new JiraClient(connection()).search(
      "assignee = currentUser()",
    ))
      issues.push(issue.id);
    expect(issues).toEqual(["1", "2"]);
    expect(fetcher.mock.calls[1][0]).toBe(
      "https://team.atlassian.net/rest/api/3/search/jql",
    );
    expect(JSON.parse(fetcher.mock.calls[1][1].body).nextPageToken).toBe(
      "page-two",
    );
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      headers: {
        Authorization: `Basic ${Buffer.from("person@example.com:secret-token").toString("base64")}`,
      },
    });
  });
  it("fetches every JSM comment page even when Jira returns fewer than requested", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ values: [{ id: "1" }], isLastPage: false }))
      .mockResolvedValueOnce(json({ values: [{ id: "2" }], isLastPage: true }));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await new JiraClient(connection()).pages(
        "/rest/servicedeskapi/request/HELP-1/comment",
        "values",
        true,
      ),
    ).toHaveLength(2);
    expect(fetcher.mock.calls[1][0]).toContain("start=1");
  });
  it("honors rate-limit metadata and surfaces required-field validation errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response("", { status: 429, headers: { "Retry-After": "120" } }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              errors: { customfield_1: "Department is required" },
            }),
            { status: 400 },
          ),
        ),
    );
    const client = new JiraClient(connection());
    await expect(client.request("/rest/api/3/myself")).rejects.toMatchObject({
      status: 429,
      retryAfter: 120,
    });
    await expect(client.request("/rest/api/3/issue")).rejects.toThrow(
      "Department is required",
    );
  });
  it("does not mistake a permission error for a non-service-desk issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 403 })),
    );
    await expect(
      new JiraClient(connection()).requestInfo("HELP-1"),
    ).rejects.toBeInstanceOf(JiraApiError);
  });
  it("opts in on every JSM attachment page and preserves multipart headers", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ values: [{ filename: "one" }], isLastPage: false }),
      )
      .mockResolvedValueOnce(json({ values: [], isLastPage: true }))
      .mockResolvedValueOnce(json({ temporaryAttachments: [] }))
      .mockResolvedValueOnce(json({ accountId: "me" }));
    vi.stubGlobal("fetch", fetcher);
    const client = new JiraClient(connection());
    await client.pages(
      "/rest/servicedeskapi/request/HELP-1/comment/12/attachment",
      "values",
      true,
    );
    await client.upload(
      "/rest/servicedeskapi/servicedesk/1/attachTemporaryFile",
      "file.txt",
      new Uint8Array([1]),
    );
    await client.request("/rest/api/3/myself");
    for (const [, init] of fetcher.mock.calls.slice(0, 3))
      expect(new Headers(init.headers).get("X-ExperimentalApi")).toBe("opt-in");
    const uploadHeaders = new Headers(fetcher.mock.calls[2][1].headers);
    expect(uploadHeaders.get("X-Atlassian-Token")).toBe("no-check");
    expect(uploadHeaders.has("Content-Type")).toBe(false);
    expect(
      new Headers(fetcher.mock.calls[3][1].headers).has("X-ExperimentalApi"),
    ).toBe(false);
  });
  it.each([
    [412, JSON.stringify({ errorMessage: "Set X-ExperimentalApi: opt-in" })],
    [412, "Set X-ExperimentalApi: opt-in"],
    [400, JSON.stringify({ errorMessage: "Set X-ExperimentalApi: opt-in" })],
    [403, JSON.stringify({ errorMessages: ["Set X-ExperimentalApi: opt-in"] })],
  ])(
    "preserves actionable JSON and plain-text errors for HTTP %s",
    async (status, body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(body, { status })),
      );
      await expect(
        new JiraClient(connection()).request(
          "/rest/servicedeskapi/request/HELP-1",
        ),
      ).rejects.toThrow("Set X-ExperimentalApi: opt-in");
    },
  );
  it("bounds error details and redacts echoed credentials", async () => {
    const authorization = Buffer.from(
      "person@example.com:secret-token",
    ).toString("base64");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            `secret-token Basic ${authorization} ${"x".repeat(20000)}`,
            { status: 412 },
          ),
        ),
    );
    const error = await new JiraClient(connection())
      .request("/rest/api/3/myself")
      .catch((error) => error);
    expect(error).toBeInstanceOf(JiraApiError);
    if (!(error instanceof JiraApiError))
      throw new Error("Expected Jira HTTP error");
    expect(error.message).toContain("[redacted]");
    expect(error.message).not.toContain("secret-token");
    expect(error.message).not.toContain(authorization);
    expect(error.message.length).toBeLessThan(1100);
  });
  it.each(["<html>proxy failure</html>", "{broken JSON"])(
    "keeps HTTP status without exposing invalid error bodies",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(body, { status: 502 })),
      );
      const error = await new JiraClient(connection())
        .download("279743")
        .catch((error) => error);
      expect(error.status).toBe(502);
      expect(error.message).not.toContain(body);
    },
  );
});
