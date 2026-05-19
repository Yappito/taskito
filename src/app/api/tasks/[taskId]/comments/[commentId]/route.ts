import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { updateTaskComment } from "@/server/services/comment-service";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ taskId: string; commentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { taskId, commentId } = await context.params;

  try {
    const payload = await request.json().catch(() => null);
    const content = typeof payload?.content === "string" ? payload.content : "";

    const comment = await updateTaskComment(prisma, {
      taskId,
      commentId,
      actorId: session.user.id,
      content,
    });

    return NextResponse.json({ comment });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update comment" },
      { status: 400 }
    );
  }
}
