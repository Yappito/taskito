import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const COMMENT_UPLOAD_DIR = path.join(process.cwd(), process.env.UPLOAD_DIR ?? "uploads", "comment-attachments");
const MAX_COMMENT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_COMMENT_ATTACHMENTS = 5;
const DOWNLOAD_MIME_TYPE = "application/octet-stream";

const INLINE_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
} as const;

type InlineImageMimeType = keyof typeof INLINE_IMAGE_TYPES;

export interface StoredCommentAttachmentInput {
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}

function sanitizeFilename(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]+/g, "").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "file";
}

export function detectInlineImageType(buffer: Uint8Array): InlineImageMimeType | null {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }

  return null;
}

export function isInlinePreviewMimeType(mimeType: string) {
  return mimeType in INLINE_IMAGE_TYPES;
}

export function getSafeAttachmentFilename(originalName: string) {
  return sanitizeFilename(path.basename(originalName));
}

export function getCommentAttachmentContentDisposition(originalName: string, mimeType: string) {
  const disposition = isInlinePreviewMimeType(mimeType) ? "inline" : "attachment";
  return `${disposition}; filename="${getSafeAttachmentFilename(originalName).replaceAll('"', "")}"`;
}

export function getCommentAttachmentResponseHeaders(originalName: string, storedMimeType: string, file: Uint8Array) {
  const detectedInlineType = detectInlineImageType(file);
  const contentType = detectedInlineType ?? DOWNLOAD_MIME_TYPE;

  return {
    contentType,
    contentDisposition: getCommentAttachmentContentDisposition(originalName, detectedInlineType ?? DOWNLOAD_MIME_TYPE),
    originalStoredMimeType: storedMimeType,
  };
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
  const buffer = Buffer.from(await file.arrayBuffer());
  const inlineImageType = detectInlineImageType(buffer);
  const extension = inlineImageType ? `.${INLINE_IMAGE_TYPES[inlineImageType]}` : path.extname(safeOriginalName).slice(0, 16);
  const storageFilename = `${randomUUID()}${extension}`;
  const storagePath = path.join(COMMENT_UPLOAD_DIR, storageFilename);
  await writeFile(storagePath, buffer);

  return {
    originalName: safeOriginalName,
    mimeType: inlineImageType ?? DOWNLOAD_MIME_TYPE,
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
