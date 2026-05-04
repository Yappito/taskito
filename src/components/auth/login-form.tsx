"use client";

import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";
import { getSafeRedirectPath } from "@/lib/safe-redirect";

interface LoginFormProps {
  callbackUrl: string;
}

/** Credentials login form used by the server-rendered login page. */
export function LoginForm({ callbackUrl }: LoginFormProps) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const formData = new FormData(event.currentTarget);
    const result = await signIn("credentials", {
      email: formData.get("email"),
      password: formData.get("password"),
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email or password");
      return;
    }

    window.location.href = getSafeRedirectPath(callbackUrl);
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center bg-[var(--color-bg)]"
    >
      <div
        className="w-full max-w-sm rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-[var(--shadow-lg)]"
      >
        <h1
          className="mb-6 text-center text-2xl font-bold text-[var(--color-text)]"
        >
          Taskito
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-[var(--color-text-secondary)]"
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-shadow focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-[var(--color-text-secondary)]"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 block w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-muted)] px-3 py-2 text-sm text-[var(--color-text)] outline-none transition-shadow focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </div>
          {error && (
            <p className="text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <p
          className="mt-4 text-center text-xs text-[var(--color-text-muted)]"
        >
          Use your account credentials.
        </p>
      </div>
    </main>
  );
}
