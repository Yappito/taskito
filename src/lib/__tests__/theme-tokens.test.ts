import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildThemeCssVariables, getThemeCollection } from "@/lib/themes";
import type { CustomThemeDefinition } from "@/lib/types";

const globalsCss = readFileSync(
  fileURLToPath(new URL("../../app/globals.css", import.meta.url)),
  "utf8"
);

const TOKEN_DECLARATION = /^--(?:color|shadow|radius)-[\w-]+$/;

function extractBlockVariables(css: string, blockPattern: RegExp): string[] {
  const match = css.match(blockPattern);
  if (!match) {
    throw new Error(`Expected CSS block matching ${blockPattern} in globals.css`);
  }
  const declarations = match[1].match(/^\s*--[\w-]+:/gm) ?? [];
  return declarations
    .map((line) => line.replace(/^[\s:]+|:$/g, "").trim())
    .filter((name) => TOKEN_DECLARATION.test(name));
}

const rootVariables = extractBlockVariables(globalsCss, /:root\s*\{([^}]*)\}/);
const darkVariables = extractBlockVariables(globalsCss, /\[data-theme="dark"\]\s*\{([^}]*)\}/);

const customTheme: CustomThemeDefinition = {
  id: "test-custom",
  name: "Test Custom",
  mode: "light",
  palette: {
    background: "#ffffff",
    backgroundElevated: "#ffffff",
    backgroundMuted: "#f0f0f0",
    surface: "#ffffff",
    border: "#dddddd",
    text: "#111111",
    textSecondary: "#444444",
    textMuted: "#888888",
    accent: "#5b5bd6",
    accentSecondary: "#22c7f2",
    success: "#22a06b",
    warning: "#e2a100",
    danger: "#d64550",
    appGradientFrom: "#8ea1ff",
    appGradientTo: "#8be4ff",
    headerGradientFrom: "#5b5bd6",
    headerGradientTo: "#22c7f2",
    spotlightGradientFrom: "#7485ff",
    spotlightGradientTo: "#b4f0ff",
  },
};

const themes = [...getThemeCollection([customTheme])];

function missingVariables(expected: string[], actual: string[]): string[] {
  const declared = new Set(actual);
  return expected.filter((name) => !declared.has(name));
}

describe("theme token invariants", () => {
  it("globals.css declares :root and dark tokens", () => {
    expect(rootVariables.length).toBeGreaterThan(0);
    expect(darkVariables.length).toBeGreaterThan(0);
  });

  it("every :root color/shadow/radius token is also declared in the dark block", () => {
    const missing = missingVariables(rootVariables, darkVariables);
    expect(
      missing,
      `[data-theme="dark"] is missing tokens declared in :root: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("every :root color/shadow/radius token is produced by every theme definition", () => {
    const failures: string[] = [];

    for (const theme of themes) {
      const variables = Object.keys(buildThemeCssVariables(theme));
      const missing = missingVariables(rootVariables, variables);
      if (missing.length > 0) {
        failures.push(`${theme.id} (${theme.mode}): ${missing.join(", ")}`);
      }
    }

    expect(
      failures,
      `themes are missing :root tokens:\n${failures.join("\n")}`
    ).toEqual([]);
  });

  it("custom themes receive the same token coverage as built-in themes", () => {
    const custom = themes.find((theme) => theme.id === "test-custom");
    expect(custom).toBeDefined();
    const variables = buildThemeCssVariables(custom!);
    expect(variables["--color-on-accent"]).toBe("#ffffff");
    expect(variables["--color-overlay"]).toBe("rgba(15, 23, 42, 0.5)");
    expect(variables["--radius-lg"]).toBe("14px");
  });

  it("dark themes use on-accent ink suited to light accent fills", () => {
    for (const theme of themes.filter((candidate) => candidate.mode === "dark")) {
      expect(buildThemeCssVariables(theme)["--color-on-accent"]).toBe("#0c0e14");
    }
  });

  it("globals.css no longer hardcodes pulse hex colours outside the token definitions", () => {
    const withoutSemanticTokens = globalsCss.replace(/^\s*--color-(?:warning|danger):.*$/gm, "");
    expect(withoutSemanticTokens).not.toMatch(/#f59e0b/);
    expect(withoutSemanticTokens).not.toMatch(/#ef4444/);
    expect(globalsCss).toMatch(/color-mix\(in srgb, var\(--color-warning\)/);
    expect(globalsCss).toMatch(/color-mix\(in srgb, var\(--color-danger\)/);
  });

  it("globals.css provides a prefers-reduced-motion fallback", () => {
    const reducedMotion = globalsCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*)\}/);
    expect(reducedMotion).not.toBeNull();
    const block = reducedMotion![1];
    expect(block).toContain(".pulse-warning");
    expect(block).toContain(".pulse-critical");
    expect(block).toContain(".edge-flow-animated");
    expect(block).toContain(".animate-pulse");
    expect(block).toContain("scroll-behavior: auto");
  });
});
