import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { bearerSessionFromIdentity, resolveBearerToken } from "@/server/services/api-tokens";
import { createTaskComment } from "@/server/services/comment-service";
import {
  getCommentAttachmentLimits,
  removeStoredCommentAttachments,
  storeCommentAttachment,
} from "@/server/services/comment-attachments";
import type { Session } from "next-auth";

export async function POST(
  request: Request,
  context: { params: Promise<{ taskId: string }> }
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

  const { taskId } = await context.params;
  const formData = await request.formData();
  const content = String(formData.get("content") ?? "");
  const files = formData
    .getAll("attachments")
    .filter((value): value is File => value instanceof File && value.size > 0);

  const { maxFiles } = getCommentAttachmentLimits();
  if (files.length > maxFiles) {
    return NextResponse.json({ error: `A comment can include at most ${maxFiles} attachments` }, { status: 400 });
  }

  const storedAttachments = [] as Awaited<ReturnType<typeof storeCommentAttachment>>[];

  try {
    for (const file of files) {
      storedAttachments.push(await storeCommentAttachment(file));
    }

    const comment = await createTaskComment(prisma, {
      taskId,
      authorId: session.user.id,
      content,
      attachments: storedAttachments,
    });

    return NextResponse.json({ comment });
  } catch (error) {
    await removeStoredCommentAttachments(storedAttachments).catch(() => undefined);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to create comment" },
      { status: 400 }
    );
  }
}