import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PROFILE_IMAGE_DIR = path.join(process.cwd(), process.env.UPLOAD_DIR ?? "uploads", "profile-images");
const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

type AllowedProfileMimeType = keyof typeof ALLOWED_IMAGE_TYPES;

export function detectProfileImageType(buffer: Uint8Array): AllowedProfileMimeType | null {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
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

  return null;
}

function getProfileImagePath(imageKey: string) {
  if (!/^[a-f0-9-]+\.(jpg|png|webp)$/i.test(imageKey)) {
    throw new Error("Invalid profile image key");
  }

  return path.join(PROFILE_IMAGE_DIR, imageKey);
}

export function getProfileImageLimits() {
  return {
    maxBytes: MAX_PROFILE_IMAGE_BYTES,
    allowedMimeTypes: Object.keys(ALLOWED_IMAGE_TYPES),
  };
}

export async function storeProfileImage(file: File) {
  if (file.size === 0) {
    throw new Error("Choose an image to upload");
  }

  if (file.size > MAX_PROFILE_IMAGE_BYTES) {
    throw new Error(`Profile photos must be ${Math.floor(MAX_PROFILE_IMAGE_BYTES / (1024 * 1024))}MB or smaller`);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const detectedType = detectProfileImageType(buffer);

  if (!detectedType) {
    throw new Error("Profile photos must be JPEG, PNG, or WebP images");
  }

  await mkdir(PROFILE_IMAGE_DIR, { recursive: true });

  const extension = ALLOWED_IMAGE_TYPES[detectedType];
  const imageKey = `${randomUUID()}.${extension}`;
  const storagePath = getProfileImagePath(imageKey);

  await writeFile(storagePath, buffer);

  return {
    imageKey,
    mimeType: detectedType,
    storagePath,
    sizeBytes: buffer.byteLength,
  };
}

export async function readStoredProfileImage(imageKey: string) {
  return readFile(getProfileImagePath(imageKey));
}

export async function removeStoredProfileImage(imageKey: string | null | undefined) {
  if (!imageKey) {
    return;
  }

  await rm(getProfileImagePath(imageKey), { force: true });
}