import { NextResponse } from "next/server";
import type { Session } from "next-auth";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bearerSessionFromIdentity, resolveBearerToken } from "@/server/services/api-tokens";
import { requireProjectAccess } from "@/server/authz";
import {
  getCommentAttachmentResponseHeaders,
  readStoredCommentAttachment,
} from "@/server/services/comment-attachments";

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string }> }
) {
  let session: Session | null = await auth();
  if (!session?.user?.id) {
    // Personal API tokens: fall back to `Authorization: Bearer tk_…`
    const identity = await resolveBearerToken(prisma, request.headers);
    session = identity ? bearerSessionFromIdentity(identity) : null;
  }
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { attachmentId } = await context.params;
  const attachment = await prisma.commentAttachment.findUnique({
    where: { id: attachmentId },
    select: {
      originalName: true,
      mimeType: true,
      storagePath: true,
      storageProvider: true,
      storageBucket: true,
      storageKey: true,
      comment: {
        select: {
          task: {
            select: {
              projectId: true,
            },
          },
        },
      },
    },
  });

  if (!attachment) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await requireProjectAccess(prisma, session.user.id, attachment.comment.task.projectId);

  const file = await readStoredCommentAttachment(attachment).catch(() => null);
  if (!file) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const safeHeaders = getCommentAttachmentResponseHeaders(attachment.originalName, attachment.mimeType, file);

  return new NextResponse(file, {
    headers: {
      "Content-Type": safeHeaders.contentType,
      "Content-Disposition": safeHeaders.contentDisposition,
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
