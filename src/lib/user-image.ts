const PROFILE_IMAGE_PREFIX = "profile:";

export function isStoredProfileImage(value: string | null | undefined) {
  return Boolean(value && value.startsWith(PROFILE_IMAGE_PREFIX));
}

export function getStoredProfileImageKey(value: string | null | undefined) {
  if (!isStoredProfileImage(value)) {
    return null;
  }

  return value!.slice(PROFILE_IMAGE_PREFIX.length) || null;
}

export function toStoredProfileImageValue(imageKey: string) {
  return `${PROFILE_IMAGE_PREFIX}${imageKey}`;
}

export function getUserImageUrl(image: string | null | undefined) {
  const imageKey = getStoredProfileImageKey(image);
  if (imageKey) {
    return `/api/profile-images/${imageKey}`;
  }

  if (!image) {
    return null;
  }

  return image;
}

export function getUserInitials(name: string | null | undefined, email: string | null | undefined) {
  const source = (name?.trim() || email?.trim() || "?").replace(/\s+/g, " ");
  const parts = source.split(" ").filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }

  return source.slice(0, 2).toUpperCase();
}