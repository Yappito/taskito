"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "./theme-provider";

/** Compact theme toggle cycling light → dark → system */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  function cycle() {
    const order = ["light", "dark", "system"] as const;
    const idx = order.indexOf(theme);
    setTheme(order[(idx + 1) % order.length]);
  }

  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${theme}`}
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
