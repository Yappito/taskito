import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { toStoredProfileImageValue } from "@/lib/user-image";
import { getCurrentActor } from "@/server/authz";
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
  try {
    await getCurrentActor(prisma, session.user.id);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
      profileImageStorageProvider: true,
      profileImageStorageBucket: true,
      profileImageStorageKey: true,
    },
  });

  try {
    const stored = await storeProfileImage(file);

    const updatedUser = await prisma.user.update({
      where: { id: session.user.id },
      data: {
        image: toStoredProfileImageValue(stored.imageKey),
        profileImageStorageProvider: stored.storageProvider,
        profileImageStorageBucket: stored.storageBucket,
        profileImageStorageKey: stored.storageKey,
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

    await removeStoredProfileImage(currentUser?.image, currentUser).catch(() => undefined);

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
  try {
    await getCurrentActor(prisma, session.user.id);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const currentUser = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      image: true,
      profileImageStorageProvider: true,
      profileImageStorageBucket: true,
      profileImageStorageKey: true,
    },
  });

  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      image: null,
      profileImageStorageProvider: "local",
      profileImageStorageBucket: null,
      profileImageStorageKey: null,
    },
  });
  await removeStoredProfileImage(currentUser?.image, currentUser).catch(() => undefined);

  return NextResponse.json({ success: true, limits: getProfileImageLimits() });
}
