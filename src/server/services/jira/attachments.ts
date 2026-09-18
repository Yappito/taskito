/** JSM AttachmentDTO differs from Jira platform attachments: it has no id. */
export interface JiraServiceDeskAttachment {
  filename: string;
  mimeType: string;
  size: number;
  _links: { jiraRest: string; content?: string };
}

export class JiraAttachmentError extends Error {}

/** Resolve a stable platform ID without fetching a response-supplied URL. */
export function normalizeJiraAttachment(value: unknown, site: string) {
  const attachment = value as Record<string, unknown> | null;
  let id = attachment?.id;
  if (id == null) {
    const links = attachment?._links as { jiraRest?: unknown } | undefined;
    try {
      if (typeof links?.jiraRest !== "string") throw new Error();
      const url = new URL(links.jiraRest);
      if (
        url.origin !== site ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      id = /^\/rest\/api\/(?:2|3)\/attachment\/(\d+)$/.exec(url.pathname)?.[1];
    } catch {
      // Never include the untrusted URL or response body in diagnostics.
    }
  }
  if (typeof id !== "string" || !/^\d+$/.test(id))
    throw new JiraAttachmentError(
      "Jira attachment response has no valid attachment ID. Check the Jira integration version and retry sync.",
    );
  if (
    !attachment ||
    typeof attachment.filename !== "string" ||
    !attachment.filename ||
    typeof attachment.size !== "number" ||
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 0
  )
    throw new JiraAttachmentError(
      "Jira attachment response has invalid file metadata. Check the Jira integration version and retry sync.",
    );
  return {
    id,
    filename: attachment.filename,
    size: attachment.size,
    mimeType:
      typeof attachment.mimeType === "string"
        ? attachment.mimeType
        : "application/octet-stream",
  };
}
