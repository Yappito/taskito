import { describe, expect, it } from "vitest";

import {
  detectInlineImageType,
  getCommentAttachmentContentDisposition,
  getCommentAttachmentResponseHeaders,
  isInlinePreviewMimeType,
} from "../comment-attachments";

describe("comment attachments", () => {
  it("only treats validated raster images as inline previewable", () => {
    expect(detectInlineImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe("image/jpeg");
    expect(detectInlineImageType(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBeNull();
    expect(isInlinePreviewMimeType("image/svg+xml")).toBe(false);
    expect(isInlinePreviewMimeType("text/html")).toBe(false);
  });

  it("serves unsafe or unknown attachment types as downloads", () => {
    expect(getCommentAttachmentContentDisposition('report".html', "application/octet-stream")).toBe(
      'attachment; filename="report-.html"'
    );
    expect(getCommentAttachmentContentDisposition("photo.png", "image/png")).toBe(
      'inline; filename="photo.png"'
    );
  });

  it("revalidates existing stored attachments before inline serving", () => {
    expect(
      getCommentAttachmentResponseHeaders("old.html", "text/html", new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c]))
    ).toMatchObject({
      contentType: "application/octet-stream",
      contentDisposition: 'attachment; filename="old.html"',
    });

    expect(
      getCommentAttachmentResponseHeaders("old-upload.bin", "application/octet-stream", new Uint8Array([0xff, 0xd8, 0xff]))
    ).toMatchObject({
      contentType: "image/jpeg",
      contentDisposition: 'inline; filename="old-upload.bin"',
    });
  });
});
