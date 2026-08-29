"use client";

import { useState } from "react";
import { PASSWORD_MIN_LENGTH, PASSWORD_MIN_LENGTH_HINT } from "@/lib/password-policy";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Avatar } from "@/components/ui/avatar";
import { trpc } from "@/lib/trpc-client";
import { useRouter } from "next/navigation";
import { useAvatarUpload } from "@/hooks/use-avatar-upload";

/** Format an optional token timestamp for the settings list. */
function formatTokenDate(value: Date | string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString(undefined, { dateStyle: "medium" });
}

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

  const [tokenName, setTokenName] = useState("");
  const [tokenExpiresInDays, setTokenExpiresInDays] = useState("");
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const { confirm, confirmElement } = useConfirm();

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

  const listApiTokens = trpc.user.listApiTokens.useQuery();
  const tokens = listApiTokens.data ?? [];

  const createApiToken = trpc.user.createApiToken.useMutation({
    onSuccess: (data) => {
      setTokenError(null);
      setTokenMessage(null);
      setCreatedToken(data.token);
      setTokenCopied(false);
      setTokenName("");
      setTokenExpiresInDays("");
      void utils.user.listApiTokens.invalidate();
    },
    onError: (error) => {
      setTokenMessage(null);
      setTokenError(error.message);
    },
  });

  const revokeApiToken = trpc.user.revokeApiToken.useMutation({
    onSuccess: () => {
      setTokenError(null);
      void utils.user.listApiTokens.invalidate();
    },
    onError: (error) => {
      setTokenError(error.message);
    },
  });

  async function copyCreatedToken() {
    if (!createdToken) return;
    try {
      await navigator.clipboard.writeText(createdToken);
      setTokenCopied(true);
      setTokenError(null);
    } catch {
      setTokenError("Copying failed — select the token text and copy it manually.");
    }
  }

  async function handleRevokeToken(id: string, name: string) {
    const confirmed = await confirm({
      title: `Revoke "${name}"?`,
      description: "Any script using this token will immediately lose access. This cannot be undone.",
      confirmLabel: "Revoke token",
      destructive: true,
    });
    if (confirmed) {
      revokeApiToken.mutate({ id });
    }
  }

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

      <section className="rounded-3xl border p-6 lg:col-span-2" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <h2 className="text-lg font-semibold" style={{ color: "var(--color-text)" }}>
          API tokens
        </h2>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
          Personal tokens let scripts and external tools call the Taskito API as you with
          {" "}
          <code>Authorization: Bearer tk_…</code>. Treat them like passwords: they are shown only once at
          creation and cannot be used for admin actions or account changes.
        </p>

        {tokens.length > 0 && (
          <ul className="mt-5 space-y-3">
            {tokens.map((token) => (
              <li key={token.id} className="rounded-2xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>{token.name}</div>
                    <code className="text-xs" style={{ color: "var(--color-text-muted)" }}>{token.tokenPrefix}…</code>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleRevokeToken(token.id, token.name)}
                    disabled={!!token.revokedAt || revokeApiToken.isPending}
                  >
                    {token.revokedAt ? "Revoked" : "Revoke"}
                  </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                  <span>Created {formatTokenDate(token.createdAt)}</span>
                  <span>Last used {formatTokenDate(token.lastUsedAt)}</span>
                  <span>{token.revokedAt ? `Revoked ${formatTokenDate(token.revokedAt)}` : token.expiresAt ? `Expires ${formatTokenDate(token.expiresAt)}` : "No expiry"}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        {createdToken && (
          <Alert className="mt-5" variant="warning" title="Copy your new token now — you won't see it again.">
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code
                className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-lg px-3 py-2"
                style={{ backgroundColor: "var(--color-bg-overlay)", border: "1px solid var(--color-border)", color: "var(--color-text)" }}
              >
                {createdToken}
              </code>
              <Button type="button" variant="outline" onClick={() => void copyCreatedToken()}>
                {tokenCopied ? "Copied!" : "Copy"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreatedToken(null);
                  setTokenMessage("Token created. Save it somewhere safe before leaving this page.");
                }}
              >
                Done
              </Button>
            </div>
          </Alert>
        )}

        <form
          className="mt-5 space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            setTokenMessage(null);
            setTokenError(null);

            const daysRaw = tokenExpiresInDays.trim();
            let expiresInDays: number | undefined;
            if (daysRaw) {
              const parsed = Number(daysRaw);
              if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
                setTokenError("Expiry must be a whole number of days between 1 and 365.");
                return;
              }
              expiresInDays = parsed;
            }

            createApiToken.mutate({ name: tokenName, expiresInDays });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Token name" required>
              {(ids) => (
                <Input
                  id={ids.id}
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                  maxLength={100}
                  placeholder="e.g. CI script"
                  required
                />
              )}
            </Field>
            <Field label="Expires in days (optional)">
              {(ids) => (
                <Input
                  id={ids.id}
                  type="number"
                  min={1}
                  max={365}
                  value={tokenExpiresInDays}
                  onChange={(event) => setTokenExpiresInDays(event.target.value)}
                  placeholder="Leave empty for no expiry"
                />
              )}
            </Field>
          </div>
          {tokenError && (
            <Alert className="mt-1" variant="danger">{tokenError}</Alert>
          )}
          {tokenMessage && (
            <Alert className="mt-1" variant="success">{tokenMessage}</Alert>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={createApiToken.isPending}>
              {createApiToken.isPending ? "Creating..." : "Create Token"}
            </Button>
          </div>
        </form>
        {confirmElement}
      </section>
    </div>
  );
}
