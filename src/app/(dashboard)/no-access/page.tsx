import Link from "next/link";

/** Authenticated landing page for users without any assigned project memberships. */
export default function NoAccessPage() {
  return (
    <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-2xl items-center px-6 py-12">
      <div
        className="w-full rounded-2xl border p-8"
        style={{
          backgroundColor: "var(--color-surface)",
          borderColor: "var(--color-border)",
          boxShadow: "var(--shadow-lg)",
        }}
      >
        <p className="text-sm font-semibold uppercase tracking-[0.2em]" style={{ color: "var(--color-text-muted)" }}>
          Restricted Access
        </p>
        <h1 className="mt-3 text-3xl font-semibold" style={{ color: "var(--color-text)" }}>
          No projects assigned
        </h1>
        <p className="mt-4 text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
          Your account is active, but it does not currently have access to any projects. Contact an administrator to assign
          you to one or more projects.
        </p>
        <div className="mt-6 flex gap-3">
          <Link
            href="/"
            className="rounded-lg px-4 py-2 text-sm font-medium"
            style={{ backgroundColor: "var(--color-accent)", color: "white" }}
          >
            Retry
          </Link>
          <Link
            href="/login"
            className="rounded-lg border px-4 py-2 text-sm font-medium"
            style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
          >
            Back to login
          </Link>
        </div>
      </div>
    </div>
  );
}