import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStoredProfileImageKey, toStoredProfileImageValue } from "@/lib/user-image";
import {
  getProfileImageLimits,
  removeStoredProfileImage,
  storeProfileImage,
} from "@/server/services/profile-images";

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("image");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Choose an image to upload" }, { status: 400 });
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      image: true,
    },
  });

  const previousImageKey = getStoredProfileImageKey(currentUser?.image);

  try {
    const stored = await storeProfileImage(file);

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        image: toStoredProfileImageValue(stored.imageKey),
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        createdAt: true,
      },
    });

    await removeStoredProfileImage(previousImageKey).catch(() => undefined);

    return NextResponse.json({ user: updatedUser });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to upload profile photo" },
      { status: 400 }
    );
  }
}

export async function DELETE() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      image: true,
    },
  });

  const currentImageKey = getStoredProfileImageKey(currentUser?.image);

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      image: null,
    },
  });
  await removeStoredProfileImage(currentImageKey).catch(() => undefined);

  return NextResponse.json({ success: true, limits: getProfileImageLimits() });
}