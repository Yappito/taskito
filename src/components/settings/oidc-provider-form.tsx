"use client";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export interface OidcProviderFormData {
  providerId: string;
  name: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  groupsClaim: string;
  defaultRole: "admin" | "member";
  allowSignup: boolean;
  allowEmailAccountLinking: boolean;
  requireEmailVerified: boolean;
  adminEmails: string;
  isEnabled: boolean;
}

export const emptyOidcProvider: OidcProviderFormData = {
  providerId: "",
  name: "",
  issuer: "",
  clientId: "",
  clientSecret: "",
  scope: "openid email profile",
  groupsClaim: "groups",
  defaultRole: "member",
  allowSignup: true,
  allowEmailAccountLinking: false,
  requireEmailVerified: false,
  adminEmails: "",
  isEnabled: true,
};

/** Parses the admin-emails textarea into the normalized list sent to the API */
export function parseAdminEmailText(value: string) {
  return [...new Set(value.split(/[\n,]/).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
}

/** OIDC callback URL for a provider id, relative to the app origin */
export function callbackUrl(origin: string, providerId: string) {
  return `${origin || "<app-url>"}/api/auth/callback/${providerId || "<provider-id>"}`;
}

export interface OidcProviderFormProps {
  value: OidcProviderFormData;
  onChange: (value: OidcProviderFormData) => void;
  isEdit?: boolean;
  /** App origin, used to render the callback URL preview */
  origin: string;
  onSubmit: () => void;
  /** Shared Cancel button: closes whichever dialog is open */
  onCancel: () => void;
  isPending: boolean;
  error?: string | null;
}

/** Create/edit form for a UI-managed OIDC provider */
export function OidcProviderForm({
  value: values,
  onChange: setValues,
  isEdit = false,
  origin,
  onSubmit,
  onCancel,
  isPending,
  error,
}: OidcProviderFormProps) {
  const toggleKeys = [
    ["isEnabled", "Enabled"],
    ["allowSignup", "Allow first-time OIDC signups"],
    ["allowEmailAccountLinking", "Allow email account linking"],
    ["requireEmailVerified", "Require verified email claim"],
  ] as const;

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Provider ID" required>
          {(ids) => (
            <>
              <Input id={ids.id} value={values.providerId} onChange={(event) => setValues({ ...values, providerId: event.target.value })} placeholder="company-sso" required />
              <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                Callback: {callbackUrl(origin, values.providerId)}
              </p>
            </>
          )}
        </Field>
        <Field label="Display Name" required>
          {(ids) => (
            <Input id={ids.id} value={values.name} onChange={(event) => setValues({ ...values, name: event.target.value })} placeholder="Company SSO" required />
          )}
        </Field>
      </div>
      <Field label="Issuer URL" required>
        {(ids) => (
          <Input id={ids.id} value={values.issuer} onChange={(event) => setValues({ ...values, issuer: event.target.value })} placeholder="https://idp.example.com/realms/taskito" required />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Client ID" required>
          {(ids) => (
            <Input id={ids.id} value={values.clientId} onChange={(event) => setValues({ ...values, clientId: event.target.value })} required />
          )}
        </Field>
        <Field label="Client Secret" required={!isEdit}>
          {(ids) => (
            <>
              <Input
                id={ids.id}
                type="password"
                value={values.clientSecret}
                onChange={(event) => setValues({ ...values, clientSecret: event.target.value })}
                placeholder={isEdit ? "Leave blank to keep current secret" : "Enter client secret"}
                required={!isEdit}
              />
              <p className="mt-1 text-xs" style={{ color: "var(--color-text-muted)" }}>
                Secrets are write-only. Saved secrets are encrypted and never returned to this page.
              </p>
            </>
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Scope" required>
          {(ids) => (
            <Input id={ids.id} value={values.scope} onChange={(event) => setValues({ ...values, scope: event.target.value })} required />
          )}
        </Field>
        <Field label="Groups Claim" required>
          {(ids) => (
            <Input id={ids.id} value={values.groupsClaim} onChange={(event) => setValues({ ...values, groupsClaim: event.target.value })} placeholder="groups or realm_access.roles" required />
          )}
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Default Role">
          {(ids) => (
            <Select id={ids.id}
              value={values.defaultRole}
              onChange={(event) => setValues({ ...values, defaultRole: event.target.value as "admin" | "member" })}
            >
              <option value="member">member</option>
              <option value="admin">admin</option>
            </Select>
          )}
        </Field>
        <Field label="Admin Emails">
          {(ids) => (
            <Textarea id={ids.id}
              value={values.adminEmails}
              onChange={(event) => setValues({ ...values, adminEmails: event.target.value })}
              rows={3}
              placeholder="admin@example.com"
            />
          )}
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {toggleKeys.map(([key, label]) => (
          <label key={key} className="flex items-center gap-3 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--color-border)", color: "var(--color-text)", backgroundColor: "var(--color-bg-overlay)" }}>
            <input
              type="checkbox"
              checked={Boolean(values[key])}
              onChange={(event) => setValues({ ...values, [key]: event.target.checked })}
              className="accent-[var(--color-accent)]"
            />
            {label}
          </label>
        ))}
      </div>
      {error && (
        <p className="text-sm" style={{ color: "var(--color-danger)" }}>
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Saving..." : isEdit ? "Save Provider" : "Create Provider"}
        </Button>
      </div>
    </form>
  );
}
