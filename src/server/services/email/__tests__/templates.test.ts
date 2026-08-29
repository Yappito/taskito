import { describe, expect, it } from "vitest";

import {
  appBaseUrl,
  escapeHtml,
  renderDigestEmail,
  renderNotificationEmail,
  taskDeepLink,
  type DigestTask,
} from "../templates";

describe("html escaping and deep links", () => {
  it("escapes all HTML-significant characters", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });

  it("builds AUTH_URL-based deep links matching the app's ?task= format", () => {
    expect(taskDeepLink("https://tasks.example.com/", "website-redesign", "abc123")).toBe(
      "https://tasks.example.com/website-redesign?task=abc123"
    );
    expect(taskDeepLink(undefined, "proj", "t1", )).toBe("/proj?task=t1");
  });

  it("reads AUTH_URL when no explicit base URL is given", () => {
    const previous = process.env.AUTH_URL;
    process.env.AUTH_URL = "https://taskito.example.com/";
    expect(appBaseUrl()).toBe("https://taskito.example.com");
    process.env.AUTH_URL = previous;
  });
});

describe("notification templates", () => {
  const base = {
    taskKey: "WEBSITE-42",
    taskTitle: 'Fix login <script>alert("x")</script>',
    projectName: "Website & Redesign",
    projectSlug: "website-redesign",
    taskId: "task-abc123",
  };

  it("renders assigned emails with actor, key + title, project and deep link", () => {
    const email = renderNotificationEmail({ type: "assigned", ...base }, "https://tasks.example.com");
    expect(email.subject).toBe('[Taskito] Someone assigned you to WEBSITE-42 Fix login <script>alert("x")</script>');
    expect(email.text).toContain("assigned you to WEBSITE-42");
    expect(email.text).toContain("Project: Website & Redesign");
    expect(email.text).toContain("https://tasks.example.com/website-redesign?task=task-abc123");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("website-redesign?task=task-abc123");
  });

  it("renders commented, statusChanged and mentioned subjects", () => {
    const commented = renderNotificationEmail({ type: "commented", actorName: "Grace", ...base }, "https://x.test");
    expect(commented.subject).toContain("Grace commented on WEBSITE-42");
    const status = renderNotificationEmail({ type: "statusChanged", actorName: "Grace", ...base }, "https://x.test");
    expect(status.subject).toContain("changed the status of WEBSITE-42");
    const mentioned = renderNotificationEmail({ type: "mentioned", actorName: "Grace", ...base }, "https://x.test");
    expect(mentioned.subject).toContain("Grace mentioned you on WEBSITE-42");
    expect(mentioned.subject).toBe(`[Taskito] Grace mentioned you on WEBSITE-42 ${base.taskTitle}`);
  });

  it("falls back to Someone when the actor has no name", () => {
    const email = renderNotificationEmail({ type: "assigned", ...base });
    expect(email.subject.startsWith("[Taskito] Someone assigned you to")).toBe(true);
  });
});

describe("digest template", () => {
  const task = (n: number): DigestTask => ({
    taskId: `t${n}`,
    key: `PROJ-${n}`,
    title: `Task ${n}`,
    projectName: "Proj",
    projectSlug: "proj",
    dueDate: "2026-08-29",
  });

  it("renders only non-empty sections", () => {
    const email = renderDigestEmail({
      overdue: [task(1)],
      dueToday: [],
      dueSoon: [task(2), task(3)],
      blockedOn: [],
    }, "https://tasks.example.com");

    expect(email.text).toContain("Overdue:");
    expect(email.text).toContain("Due soon:");
    expect(email.text).not.toContain("Due today:");
    expect(email.text).not.toContain("Blocked on you:");
    expect(email.text).toContain("PROJ-1 Task 1");
    expect(email.text).toContain("https://tasks.example.com/proj?task=t1");
    expect(email.html).toContain("PROJ-1");
  });

  it("counts tasks in the subject", () => {
    const email = renderDigestEmail({
      overdue: [],
      dueToday: [task(9)],
      dueSoon: [],
      blockedOn: [],
    }, "https://tasks.example.com");
    expect(email.subject).toContain("1 task");
  });

  it("escapes task titles in html", () => {
    const email = renderDigestEmail({
      overdue: [{ ...task(1), title: "<b>t</b>" }],
      dueToday: [],
      dueSoon: [],
      blockedOn: [],
    }, "https://x.test");
    expect(email.html).toContain("&lt;b&gt;t&lt;/b&gt;");
    expect(email.html).not.toContain("<b>t</b>");
  });
});