"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

/**
 * Profile photo upload/removal logic (POST/DELETE /api/profile-image) plus the
 * busy/error/message state and invalidation of the affected user queries.
 */
export function useAvatarUpload() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function refreshProfileData() {
    await Promise.all([
      utils.user.me.invalidate(),
      utils.user.list.invalidate(),
    ]);
    router.refresh();
  }

  async function uploadAvatar(file: File) {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const formData = new FormData();
      formData.append("image", file);

      const response = await fetch("/api/profile-image", {
        method: "POST",
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Unable to upload profile photo");
      }

      setMessage("Profile photo updated.");
      await refreshProfileData();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to upload profile photo");
    } finally {
      setBusy(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function removeAvatar() {
    setBusy(true);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch("/api/profile-image", {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(typeof payload.error === "string" ? payload.error : "Unable to remove profile photo");
      }

      setMessage("Profile photo removed.");
      await refreshProfileData();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to remove profile photo");
    } finally {
      setBusy(false);
    }
  }

  return { fileInputRef, busy, error, message, uploadAvatar, removeAvatar };
}
