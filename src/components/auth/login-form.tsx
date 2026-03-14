"use client";

import { signIn } from "next-auth/react";
import { useState, type FormEvent } from "react";

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

    window.location.href = callbackUrl;
  }

  return (
    <main
      className="flex min-h-screen items-center justify-center"
      style={{ backgroundColor: "var(--color-bg)" }}
    >
      <div
        className="w-full max-w-sm rounded-xl p-8"
        style={{
          backgroundColor: "var(--color-surface)",
          boxShadow: "var(--shadow-lg)",
          border: "1px solid var(--color-border)",
        }}
      >
        <h1
          className="mb-6 text-center text-2xl font-bold"
          style={{ color: "var(--color-text)" }}
        >
          Taskito
        </h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="mt-1 block w-full rounded-lg px-3 py-2 text-sm outline-none transition-shadow"
              style={{
                backgroundColor: "var(--color-bg-muted)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
              onFocus={(event) => {
                event.currentTarget.style.boxShadow = "0 0 0 2px var(--color-accent)";
              }}
              onBlur={(event) => {
                event.currentTarget.style.boxShadow = "none";
              }}
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="mt-1 block w-full rounded-lg px-3 py-2 text-sm outline-none transition-shadow"
              style={{
                backgroundColor: "var(--color-bg-muted)",
                border: "1px solid var(--color-border)",
                color: "var(--color-text)",
              }}
              onFocus={(event) => {
                event.currentTarget.style.boxShadow = "0 0 0 2px var(--color-accent)";
              }}
              onBlur={(event) => {
                event.currentTarget.style.boxShadow = "none";
              }}
            />
          </div>
          {error && (
            <p className="text-sm" style={{ color: "var(--color-danger)" }}>
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
            style={{ backgroundColor: "var(--color-accent)" }}
            onMouseEnter={(event) => {
              event.currentTarget.style.backgroundColor = "var(--color-accent-hover)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.backgroundColor = "var(--color-accent)";
            }}
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        <p
          className="mt-4 text-center text-xs"
          style={{ color: "var(--color-text-muted)" }}
        >
          Use your account credentials.
        </p>
      </div>
    </main>
  );
}
