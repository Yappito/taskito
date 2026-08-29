"use client";

import { useState } from "react";
import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH_HINT } from "@/lib/password-policy";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/avatar";
import { trpc } from "@/lib/trpc-client";
import { useRouter } from "next/navigation";
import { useAvatarUpload } from "@/hooks/use-avatar-upload";

/** Profile tab: identity card, profile photo, display name and password change */
export function ProfileSettings({
  currentUser,
}: {
  currentUser: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    role: string;
    createdAt: Date | string;
  };
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const { fileInputRef, busy: avatarBusy, error: avatarError, message: avatarMessage, uploadAvatar, removeAvatar } = useAvatarUpload();
  const [profileName, setProfileName] = useState(currentUser.name ?? "");
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
  });
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const updateProfile = trpc.user.updateProfile.useMutation({
    onSuccess: async () => {
      setProfileError(null);
      setProfileMessage("Profile updated.");
      await Promise.all([
        utils.user.me.invalidate(),
        utils.user.list.invalidate(),
      ]);
      router.refresh();
    },
    onError: (error) => {
      setProfileMessage(null);
      setProfileError(error.message);
    },
  });

  const changePassword = trpc.user.changePassword.useMutation({
    onSuccess: () => {
      setPasswordError(null);
      setPasswordMessage("Password changed.");
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
    },
    onError: (error) => {
      setPasswordMessage(null);
      setPasswordError(error.message);
    },
  });

  return (
    <div className="grid gap-6 lg:grid-cols-[1.05fr_1.25fr]">
      <section
        className="overflow-hidden rounded-3xl border"
        style={{
          borderColor: "color-mix(in srgb, var(--color-accent) 24%, var(--color-border))",
          background:
            "linear-gradient(160deg, color-mix(in srgb, var(--color-accent) 13%, var(--color-surface)) 0%, var(--color-surface) 52%, color-mix(in srgb, var(--color-accent) 8%, var(--color-bg-overlay)) 100%)",
        }}
      >
        <div className="border-b px-6 py-5" style={{ borderColor: "color-mix(in srgb, var(--color-accent) 15%, var(--color-border))" }}>
          <p className="text-xs font-semibold uppercase tracking-[0.26em]" style={{ color: "var(--color-text-muted)" }}>
            Identity
          </p>
          <h2 className="mt-2 text-xl font-semibold" style={{ color: "var(--color-text)" }}>
            Profile
          </h2>
        </div>
        <div className="space-y-5 px-6 py-6">
          <div className="flex items-center gap-4">
            <Avatar name={currentUser.name} email={currentUser.email} image={currentUser.image} size="xl" />
            <div className="min-w-0">
              <div className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
                {currentUser.name?.trim() || "Unnamed user"}
              </div>
              <div className="truncate text-sm" style={{ color: "var(--color-text-secondary)" }}>
                {currentUser.email}
              </div>
              <div className="mt-2 inline-flex rounded-full px-2.5 py-1 text-[11px] font-medium capitalize" style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text-muted)" }}>
                {currentUser.role}
              </div>
            </div>
          </div>

          <div
            className="rounded-2xl border p-4"
            style={{
              borderColor: "var(--color-border)",
              backgroundColor: "color-mix(in srgb, var(--color-bg-overlay) 70%, transparent)",
            }}
          >
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={() => fileInputRef.current?.click()} disabled={avatarBusy}>
                {avatarBusy ? "Working..." : "Upload Photo"}
              </Button>
              <Button type="button" variant="outline" onClick={() => void removeAvatar()} disabled={avatarBusy || !currentUser.image}>
                Remove Photo
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) {
                    void uploadAvatar(file);
                  }
                }}
              />
            </div>
            <p className="mt-3 text-sm" style={{ color: "var(--color-text-secondary)" }}>
              Upload JPEG, PNG, or WebP up to 2MB. Photos are stored privately and served from authenticated routes only.
            </p>
            {avatarError && (
              <p className="mt-3 text-sm" style={{ color: "var(--color-danger)" }}>
                {avatarError}
              </p>
            )}
            {avatarMessage && (
              <p className="mt-3 text-sm" style={{ color: "var(--color-accent)" }}>
                {avatarMessage}
              </p>
            )}
          </div>

          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
              <div style={{ color: "var(--color-text-muted)" }}>Member since</div>
              <div className="mt-1 font-medium" style={{ color: "var(--color-text)" }}>
                {new Date(currentUser.createdAt).toLocaleDateString()}
              </div>
            </div>
            <div className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
              <div style={{ color: "var(--color-text-muted)" }}>Password policy</div>
              <div className="mt-1 font-medium" style={{ color: "var(--color-text)" }}>
                At least {PASSWORD_MIN_LENGTH} characters
              </div>
            </div>
          </div>
        </div>
      </section>

      <div className="space-y-6">
        <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
            Display Name
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
            This name appears in assignments, notifications, and task activity.
          </p>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setProfileMessage(null);
              setProfileError(null);
              updateProfile.mutate({ name: profileName });
            }}
          >
            <Field label="Name" required>
              {(ids) => (
                <Input id={ids.id} value={profileName} onChange={(event) => setProfileName(event.target.value)} required />
              )}
            </Field>
            {profileError && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {profileError}
              </p>
            )}
            {profileMessage && (
              <p className="text-sm" style={{ color: "var(--color-accent)" }}>
                {profileMessage}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={updateProfile.isPending}>
                {updateProfile.isPending ? "Saving..." : "Save Profile"}
              </Button>
            </div>
          </form>
        </section>

        <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
          <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
            Change Password
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
            Use your current password to set a new one. New passwords must be at least {PASSWORD_MIN_LENGTH} characters.
          </p>
          <form
            className="mt-5 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              setPasswordMessage(null);
              setPasswordError(null);

              if (passwordForm.newPassword !== passwordForm.confirmPassword) {
                setPasswordError("The new password confirmation does not match.");
                return;
              }

              changePassword.mutate({
                currentPassword: passwordForm.currentPassword,
                newPassword: passwordForm.newPassword,
              });
            }}
          >
            <Field label="Current Password" required>
              {(ids) => (
                <Input id={ids.id}
                  type="password"
                  value={passwordForm.currentPassword}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                  required
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="New Password" required>
                {(ids) => (
                  <Input id={ids.id}
                    type="password"
                    minLength={PASSWORD_MIN_LENGTH}
                    placeholder={PASSWORD_MIN_LENGTH_HINT}
                    value={passwordForm.newPassword}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, newPassword: event.target.value }))}
                    required
                  />
                )}
              </Field>
              <Field label="Confirm Password" required>
                {(ids) => (
                  <Input id={ids.id}
                    type="password"
                    minLength={PASSWORD_MIN_LENGTH}
                    value={passwordForm.confirmPassword}
                    onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                    required
                  />
                )}
              </Field>
            </div>
            {passwordError && (
              <p className="text-sm" style={{ color: "var(--color-danger)" }}>
                {passwordError}
              </p>
            )}
            {passwordMessage && (
              <p className="text-sm" style={{ color: "var(--color-accent)" }}>
                {passwordMessage}
              </p>
            )}
            <div className="flex justify-end">
              <Button type="submit" disabled={changePassword.isPending}>
                {changePassword.isPending ? "Updating..." : "Update Password"}
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}
