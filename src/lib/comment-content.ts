export interface CommentAttachmentReference {
  originalName: string;
}

export function normalizeCommentContent(content: string) {
  return content.trim();
}

export function buildCommentAttachmentReferenceBlock(attachments: CommentAttachmentReference[]) {
  if (attachments.length === 0) {
    return "";
  }

  return `Attachments:\n${attachments.map((attachment) => `- ${attachment.originalName}`).join("\n")}`;
}

export function getCommentBody(
  content: string,
  attachments?: CommentAttachmentReference[] | null
) {
  const trimmedContent = normalizeCommentContent(content);
  const attachmentReferenceBlock = buildCommentAttachmentReferenceBlock(attachments ?? []);

  if (!attachmentReferenceBlock) {
    return trimmedContent;
  }

  if (trimmedContent === attachmentReferenceBlock) {
    return "";
  }

  const attachmentSuffix = `\n\n${attachmentReferenceBlock}`;
  if (trimmedContent.endsWith(attachmentSuffix)) {
    return trimmedContent.slice(0, -attachmentSuffix.length).trimEnd();
  }

  return trimmedContent;
}
