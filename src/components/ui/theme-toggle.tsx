"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "./theme-provider";
import { trpc } from "@/lib/trpc-client";

/** Compact theme toggle cycling light → dark → system */
export function ThemeToggle() {
  const { appearance, theme, setTheme, activeTheme } = useTheme();
  const updateAppearance = trpc.user.updateAppearance.useMutation();

  function cycle() {
    const order = ["light", "dark", "system"] as const;
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length];
    setTheme(next);
    // Persist so the choice survives reloads, mirroring the appearance settings
    // page (the provider itself does not write to the server).
    updateAppearance.mutate({ ...appearance, scheme: next });
  }

  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${theme}`}
      title={`${activeTheme.name} (${theme})`}
      className="rounded-md p-1.5 transition-colors"
      style={{
        color: "var(--color-text-muted)",
        backgroundColor: "transparent",
      }}
      onMouseEnter={(e) =>
        (e.currentTarget.style.backgroundColor = "var(--color-surface-hover)")
      }
      onMouseLeave={(e) =>
        (e.currentTarget.style.backgroundColor = "transparent")
      }
    >
      {theme === "light" && <Sun size={16} />}
      {theme === "dark" && <Moon size={16} />}
      {theme === "system" && <Monitor size={16} />}
    </button>
  );
}
