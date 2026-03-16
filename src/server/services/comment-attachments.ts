import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const COMMENT_UPLOAD_DIR = path.join(process.cwd(), process.env.UPLOAD_DIR ?? "uploads", "comment-attachments");
const MAX_COMMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_COMMENT_ATTACHMENTS = 5;

export interface StoredCommentAttachmentInput {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}

function sanitizeFilename(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "file";
}

export function getCommentAttachmentLimits() {
  return {
    maxBytes: MAX_COMMENT_ATTACHMENT_BYTES,
    maxFiles: MAX_COMMENT_ATTACHMENTS,
  };
}

export async function storeCommentAttachment(file: File): Promise<StoredCommentAttachmentInput> {
  if (file.size > MAX_COMMENT_ATTACHMENT_BYTES) {
    throw new Error(`Files must be ${Math.floor(MAX_COMMENT_ATTACHMENT_BYTES / (1024 * 1024))}MB or smaller`);
  }

  await mkdir(COMMENT_UPLOAD_DIR, { recursive: true });

  const safeOriginalName = sanitizeFilename(file.name);
  const extension = path.extname(safeOriginalName);
  const storageFilename = `${randomUUID()}${extension}`;
  const storagePath = path.join(COMMENT_UPLOAD_DIR, storageFilename);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(storagePath, buffer);

  return {
    originalName: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    storagePath,
  };
}

export async function removeStoredCommentAttachments(attachments: StoredCommentAttachmentInput[]) {
  await Promise.all(
    attachments.map((attachment) => rm(attachment.storagePath, { force: true }))
  );
}

export async function readStoredCommentAttachment(storagePath: string) {
  return readFile(storagePath);
}