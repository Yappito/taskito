"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { AppearanceSettings, CustomThemeDefinition } from "@/lib/types";
import {
  buildThemeCssVariables,
  DEFAULT_APPEARANCE_SETTINGS,
  getThemeCollectionByMode,
  resolveThemeDefinition,
  type ThemeDefinition,
  type ThemeMode,
  type ThemePreference,
} from "@/lib/themes";

interface ThemeContextValue {
  appearance: AppearanceSettings;
  theme: ThemePreference;
  resolved: ThemeMode;
  activeTheme: ThemeDefinition;
  themesByMode: ReturnType<typeof getThemeCollectionByMode>;
  setAppearance: (appearance: AppearanceSettings) => void;
  setTheme: (theme: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  appearance: DEFAULT_APPEARANCE_SETTINGS,
  theme: DEFAULT_APPEARANCE_SETTINGS.scheme,
  resolved: "light",
  activeTheme: resolveThemeDefinition(DEFAULT_APPEARANCE_SETTINGS, "light"),
  themesByMode: getThemeCollectionByMode(),
  setAppearance: () => {},
  setTheme: () => {},
});

function getSystemTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function resolveScheme(scheme: ThemePreference): ThemeMode {
  return scheme === "system" ? getSystemTheme() : scheme;
}

function applyTheme(theme: ThemeDefinition) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.mode);
  root.setAttribute("data-theme-id", theme.id);

  const variables = buildThemeCssVariables(theme);
  for (const [token, value] of Object.entries(variables)) {
    root.style.setProperty(token, value);
  }
}

export function ThemeProvider({
  children,
  initialAppearance,
}: {
  children: React.ReactNode;
  initialAppearance?: AppearanceSettings;
}) {
  const [appearance, setAppearanceState] = useState<AppearanceSettings>(initialAppearance ?? DEFAULT_APPEARANCE_SETTINGS);
  const [resolved, setResolved] = useState<ThemeMode>(() => resolveScheme(initialAppearance?.scheme ?? DEFAULT_APPEARANCE_SETTINGS.scheme));

  useEffect(() => {
    if (!initialAppearance) return;
    setAppearanceState(initialAppearance);
    setResolved(resolveScheme(initialAppearance.scheme));
  }, [initialAppearance]);

  useEffect(() => {
    const nextResolved = resolveScheme(appearance.scheme);
    setResolved((current) => (current === nextResolved ? current : nextResolved));
  }, [appearance.scheme]);

  useEffect(() => {
    if (appearance.scheme !== "system") return;
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => setResolved(getSystemTheme());
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [appearance.scheme]);

  const activeTheme = useMemo(
    () => resolveThemeDefinition(appearance, resolved),
    [appearance, resolved]
  );

  useEffect(() => {
    applyTheme(activeTheme);
  }, [activeTheme]);

  const themesByMode = useMemo(
    () => getThemeCollectionByMode(appearance.customThemes as CustomThemeDefinition[]),
    [appearance.customThemes]
  );

  const value = useMemo<ThemeContextValue>(() => ({
    appearance,
    theme: appearance.scheme,
    resolved,
    activeTheme,
    themesByMode,
    setAppearance: setAppearanceState,
    setTheme: (theme) => {
      setAppearanceState((current) => ({
        ...current,
        scheme: theme,
      }));
    },
  }), [activeTheme, appearance, resolved, themesByMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  return useContext(ThemeContext);
}
