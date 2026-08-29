import type { NotificationType } from "@prisma/client";

/**
 * Email templates: one per notification type plus the daily due-soon digest.
 * All user-authored content is escaped; deep links use AUTH_URL + the
 * `/{projectSlug}?task={taskId}` format the project page reacts to.
 */

export interface NotificationEmailInput {
  type: NotificationType;
  actorName?: string | null;
  taskKey?: string | null;
  taskTitle?: string | null;
  projectName?: string | null;
  projectSlug?: string | null;
  taskId?: string | null;
}

export interface DigestTask {
  taskId: string;
  key: string;
  title: string;
  projectName: string;
  projectSlug: string;
  dueDate: string; // ISO timestamp
}

export interface DigestEmailInput {
  overdue: DigestTask[];
  dueToday: DigestTask[];
  dueSoon: DigestTask[];
  blockedOn: DigestTask[];
}

/** Public base URL of the app (AUTH_URL), without a trailing slash. */
export function appBaseUrl(baseUrl?: string | null): string {
  const raw = baseUrl ?? process.env.AUTH_URL ?? "";
  return raw.replace(/\/+$/, "").trim();
}

/**
 * Deep link to open a task: `{AUTH_URL}/{project.slug}?task={taskId}`.
 * The project page reads the `task` query param and opens the task detail.
 */
export function taskDeepLink(
  baseUrl: string | null | undefined,
  projectSlug: string | null | undefined,
  taskId: string | null | undefined
): string {
  const slug = projectSlug ?? "";
  const id = taskId ?? "";
  return `${appBaseUrl(baseUrl)}/${slug}?task=${id}`;
}

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function taskLabel(input: NotificationEmailInput): string {
  const key = input.taskKey ? `${input.taskKey} ` : "";
  return `${key}${input.taskTitle ?? "a task"}`.trim();
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const HEADLINES: Record<NotificationType, string> = {
  assigned: "assigned you to",
  commented: "commented on",
  statusChanged: "changed the status of",
  mentioned: "mentioned you on",
};

/** Render the notification-type specific email (subject, text, html). */
export function renderNotificationEmail(input: NotificationEmailInput, baseUrl?: string | null): RenderedEmail {
  const label = taskLabel(input);
  const actor = input.actorName?.trim() || "Someone";
  const headline = HEADLINES[input.type];
  const href = taskDeepLink(baseUrl, input.projectSlug, input.taskId);

  const textParts = [
    `${actor} ${headline} ${label}.`,
    input.projectName ? `Project: ${input.projectName}` : "",
    `Open in Taskito: ${href}`,
  ].filter((part) => part.length > 0);

  const bodyLines = `
<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">
  <p style="margin:0 0 12px"><strong>${escapeHtml(actor)}</strong> ${escapeHtml(headline)}</p>
  <p style="margin:0 0 4px"><a href="${escapeHtml(href)}"><strong>${escapeHtml(label)}</strong></a></p>
  ${input.projectName ? `<p style="margin:0;color:#667085;font-size:12px">Project: ${escapeHtml(input.projectName)}</p>` : ""}
  <p style="margin:14px 0 0"><a href="${escapeHtml(href)}">Open in Taskito</a></p>
</div>`;

  return {
    subject: `[Taskito] ${actor} ${headline} ${label}`,
    text: textParts.join("\n\n"),
    html: bodyLines.trim(),
  };
}

function digestTextRow(task: DigestTask, baseUrl: string | null | undefined): string {
  const label = `${task.key} ${task.title}`.trim();
  const href = taskDeepLink(baseUrl, task.projectSlug, task.taskId);
  return `${label} (Project: ${task.projectName}, due ${task.dueDate}) - ${href}`;
}

function digestHtmlRow(task: DigestTask, baseUrl: string | null | undefined): string {
  const href = taskDeepLink(baseUrl, task.projectSlug, task.taskId);
  const label = `${escapeHtml(task.key)} ${escapeHtml(task.title)}`.trim();
  return `<li style="margin:0 0 6px"><a href="${escapeHtml(href)}">${label}</a> ` +
    `<span style="color:#667085">- ${escapeHtml(task.projectName)}, due ${escapeHtml(task.dueDate)}</span></li>`;
}

/** Render the daily due-soon digest email (subject, text, html). */
export function renderDigestEmail(input: DigestEmailInput, baseUrl?: string | null): RenderedEmail {
  const sections: Array<{ title: string; tasks: DigestTask[] }> = [
    { title: "Overdue", tasks: input.overdue },
    { title: "Due today", tasks: input.dueToday },
    { title: "Due soon", tasks: input.dueSoon },
    { title: "Blocked on you", tasks: input.blockedOn },
  ];
  const active = sections.filter((section) => section.tasks.length > 0);
  const total = active.reduce((sum, section) => sum + section.tasks.length, 0);
  const subjectDate = new Date().toISOString().slice(0, 10);

  const textParts: string[] = [`Your Taskito due-soon digest (${total} task${total === 1 ? "" : "s"}):`, ""];
  const htmlParts: string[] = [
    `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">`,
    `<p style="margin:0 0 12px"><strong>Your due-soon digest - ${total} task${total === 1 ? "" : "s"}:</strong></p>`,
  ];

  for (const section of active) {
    textParts.push(`${section.title}:`);
    for (const task of section.tasks) {
      textParts.push(`  - ${digestTextRow(task, baseUrl)}`);
    }
    textParts.push("");
    htmlParts.push(
      `<p style="margin:12px 0 4px"><strong>${escapeHtml(section.title)}</strong></p>`,
      `<ul style="margin:0;padding-left:18px">`,
      ...section.tasks.map((task) => digestHtmlRow(task, baseUrl)),
      `</ul>`
    );
  }
  htmlParts.push(`</div>`);

  return {
    subject: `[Taskito] You have ${total} task${total === 1 ? "" : "s"} due or blocked (digest for ${subjectDate})`,
    text: textParts.join("\n"),
    html: htmlParts.join("\n"),
  };
}