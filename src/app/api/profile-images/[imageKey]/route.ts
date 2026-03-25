import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toStoredProfileImageValue } from "@/lib/user-image";
import { readStoredProfileImage } from "@/server/services/profile-images";

export async function GET(
  _request: Request,
  context: { params: Promise<{ imageKey: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { imageKey } = await context.params;
  const user = await prisma.user.findFirst({
    where: {
      image: toStoredProfileImageValue(imageKey),
    },
    select: {
      image: true,
    },
  });

  if (!user?.image) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const file = await readStoredProfileImage(imageKey).catch(() => null);
  if (!file) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const mimeType = imageKey.endsWith(".png")
    ? "image/png"
    : imageKey.endsWith(".webp")
      ? "image/webp"
      : "image/jpeg";

  return new NextResponse(file, {
    headers: {
      "Content-Type": mimeType,
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": `inline; filename="${imageKey}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}