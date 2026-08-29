import { z } from "zod";
import type { AppearanceSettings, CustomThemeDefinition, ThemePalette } from "@/lib/types";

export const THEME_PREFERENCES = ["light", "dark", "system"] as const;
export const THEME_MODES = ["light", "dark"] as const;

export type ThemePreference = typeof THEME_PREFERENCES[number];
export type ThemeMode = typeof THEME_MODES[number];
export type ThemeKind = "preset" | "custom";

export interface ThemeDefinition extends CustomThemeDefinition {
  kind: ThemeKind;
}

const hexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const themePaletteSchema = z.object({
  background: hexColorSchema,
  backgroundElevated: hexColorSchema,
  backgroundMuted: hexColorSchema,
  surface: hexColorSchema,
  border: hexColorSchema,
  text: hexColorSchema,
  textSecondary: hexColorSchema,
  textMuted: hexColorSchema,
  accent: hexColorSchema,
  accentSecondary: hexColorSchema,
  success: hexColorSchema,
  warning: hexColorSchema,
  danger: hexColorSchema,
  appGradientFrom: hexColorSchema,
  appGradientTo: hexColorSchema,
  headerGradientFrom: hexColorSchema,
  headerGradientTo: hexColorSchema,
  spotlightGradientFrom: hexColorSchema,
  spotlightGradientTo: hexColorSchema,
});

export const customThemeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(140).optional(),
  mode: z.enum(THEME_MODES),
  palette: themePaletteSchema,
});

export const appearanceSettingsInputSchema = z.object({
  scheme: z.enum(THEME_PREFERENCES),
  lightThemeId: z.string().trim().min(1).max(64),
  darkThemeId: z.string().trim().min(1).max(64),
  customThemes: z.array(customThemeSchema).max(24),
});

function createTheme(definition: Omit<ThemeDefinition, "kind">): ThemeDefinition {
  return {
    ...definition,
    kind: "preset",
  };
}

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  createTheme({
    id: "horizon-light",
    name: "Horizon",
    description: "Soft indigo with crisp cloud surfaces.",
    mode: "light",
    palette: {
      background: "#f5f7ff",
      backgroundElevated: "#ffffff",
      backgroundMuted: "#e9eefb",
      surface: "#ffffff",
      border: "#d9e2f2",
      text: "#10203a",
      textSecondary: "#4a5c7a",
      textMuted: "#7f90ad",
      accent: "#5562ff",
      accentSecondary: "#22c7f2",
      success: "#14b87a",
      warning: "#f59e0b",
      danger: "#ef5a6f",
      appGradientFrom: "#8ea1ff",
      appGradientTo: "#8be4ff",
      headerGradientFrom: "#5562ff",
      headerGradientTo: "#22c7f2",
      spotlightGradientFrom: "#7485ff",
      spotlightGradientTo: "#b4f0ff",
    },
  }),
  createTheme({
    id: "atelier-light",
    name: "Atelier",
    description: "Warm porcelain with coral and apricot energy.",
    mode: "light",
    palette: {
      background: "#fff8f5",
      backgroundElevated: "#fffdfb",
      backgroundMuted: "#ffece2",
      surface: "#fffdf9",
      border: "#f2d7cb",
      text: "#3a1e18",
      textSecondary: "#7f5146",
      textMuted: "#b08a7f",
      accent: "#f26b4b",
      accentSecondary: "#f7b267",
      success: "#1f9d72",
      warning: "#d98b1d",
      danger: "#d94b64",
      appGradientFrom: "#ffd3bd",
      appGradientTo: "#ffe7b2",
      headerGradientFrom: "#f26b4b",
      headerGradientTo: "#f7b267",
      spotlightGradientFrom: "#ffb690",
      spotlightGradientTo: "#ffe0a8",
    },
  }),
  createTheme({
    id: "canopy-light",
    name: "Canopy",
    description: "Natural greens with airy mint highlights.",
    mode: "light",
    palette: {
      background: "#f4fbf8",
      backgroundElevated: "#ffffff",
      backgroundMuted: "#e2f4ec",
      surface: "#fbfffd",
      border: "#cfe6da",
      text: "#123025",
      textSecondary: "#45685a",
      textMuted: "#7b9d8f",
      accent: "#1d9f6e",
      accentSecondary: "#39c6b1",
      success: "#22a66f",
      warning: "#d8a11d",
      danger: "#d85d68",
      appGradientFrom: "#9fe0c4",
      appGradientTo: "#97f3ea",
      headerGradientFrom: "#1d9f6e",
      headerGradientTo: "#39c6b1",
      spotlightGradientFrom: "#78d7ad",
      spotlightGradientTo: "#b5fff3",
    },
  }),
  createTheme({
    id: "paper-ink-light",
    name: "Paper Ink",
    description: "Editorial neutrals with electric blue contrast.",
    mode: "light",
    palette: {
      background: "#f8f8f7",
      backgroundElevated: "#ffffff",
      backgroundMuted: "#eeeeea",
      surface: "#ffffff",
      border: "#deded6",
      text: "#161618",
      textSecondary: "#51515a",
      textMuted: "#8a8a95",
      accent: "#2f5bff",
      accentSecondary: "#7a5cff",
      success: "#1f9d72",
      warning: "#c68c18",
      danger: "#dd4d67",
      appGradientFrom: "#cad4ff",
      appGradientTo: "#e1d8ff",
      headerGradientFrom: "#2f5bff",
      headerGradientTo: "#7a5cff",
      spotlightGradientFrom: "#aebdff",
      spotlightGradientTo: "#d8cbff",
    },
  }),
  createTheme({
    id: "midnight-neon-dark",
    name: "Midnight Neon",
    description: "Deep indigo with neon cyan lift.",
    mode: "dark",
    palette: {
      background: "#090b14",
      backgroundElevated: "#111729",
      backgroundMuted: "#181f35",
      surface: "#131b2e",
      border: "#27304a",
      text: "#e8ecff",
      textSecondary: "#a3b0d3",
      textMuted: "#6e7a9e",
      accent: "#7c89ff",
      accentSecondary: "#24d2ff",
      success: "#35d59b",
      warning: "#ffbe3c",
      danger: "#ff6b7e",
      appGradientFrom: "#263d9c",
      appGradientTo: "#0ea5d9",
      headerGradientFrom: "#7c89ff",
      headerGradientTo: "#24d2ff",
      spotlightGradientFrom: "#4d5ae7",
      spotlightGradientTo: "#0d9fd4",
    },
  }),
  createTheme({
    id: "ember-dark",
    name: "Ember",
    description: "Volcanic charcoal with amber and ember reds.",
    mode: "dark",
    palette: {
      background: "#120d0c",
      backgroundElevated: "#1a1311",
      backgroundMuted: "#251b18",
      surface: "#211815",
      border: "#3a2b26",
      text: "#fff0eb",
      textSecondary: "#d6b0a3",
      textMuted: "#916f66",
      accent: "#ff8a4c",
      accentSecondary: "#ff4d6d",
      success: "#41d6a4",
      warning: "#ffb347",
      danger: "#ff6f61",
      appGradientFrom: "#7a2f15",
      appGradientTo: "#8f1d4c",
      headerGradientFrom: "#ff8a4c",
      headerGradientTo: "#ff4d6d",
      spotlightGradientFrom: "#a84921",
      spotlightGradientTo: "#93224f",
    },
  }),
  createTheme({
    id: "signal-dark",
    name: "Signal",
    description: "Operator green with cool aquatic glow.",
    mode: "dark",
    palette: {
      background: "#07110e",
      backgroundElevated: "#0d1815",
      backgroundMuted: "#15231e",
      surface: "#11201b",
      border: "#244036",
      text: "#e7fff5",
      textSecondary: "#a7d6c5",
      textMuted: "#679381",
      accent: "#27c983",
      accentSecondary: "#2fd7c4",
      success: "#38d39a",
      warning: "#f5b942",
      danger: "#ff7187",
      appGradientFrom: "#145940",
      appGradientTo: "#0e7380",
      headerGradientFrom: "#27c983",
      headerGradientTo: "#2fd7c4",
      spotlightGradientFrom: "#1c8d63",
      spotlightGradientTo: "#117f8b",
    },
  }),
  createTheme({
    id: "ultraviolet-dark",
    name: "Ultraviolet",
    description: "Velvet violet with magenta and blue bloom.",
    mode: "dark",
    palette: {
      background: "#0c0816",
      backgroundElevated: "#161028",
      backgroundMuted: "#1d1736",
      surface: "#19142e",
      border: "#32295a",
      text: "#f3edff",
      textSecondary: "#c3b5e6",
      textMuted: "#8777b1",
      accent: "#9b6dff",
      accentSecondary: "#ff5fd2",
      success: "#33d69f",
      warning: "#ffc24a",
      danger: "#ff748e",
      appGradientFrom: "#4a1f8d",
      appGradientTo: "#7420b7",
      headerGradientFrom: "#9b6dff",
      headerGradientTo: "#ff5fd2",
      spotlightGradientFrom: "#6932c1",
      spotlightGradientTo: "#a326c0",
    },
  }),
];

export const DEFAULT_LIGHT_THEME_ID = "horizon-light";
export const DEFAULT_DARK_THEME_ID = "midnight-neon-dark";

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  scheme: "system",
  lightThemeId: DEFAULT_LIGHT_THEME_ID,
  darkThemeId: DEFAULT_DARK_THEME_ID,
  customThemes: [],
};

function normalizeHex(hex: string) {
  return hex.trim().toLowerCase();
}

function parseRgb(hex: string) {
  const clean = normalizeHex(hex).replace("#", "");
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  };
}

function toHex(value: number) {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}

function mixHex(from: string, to: string, ratio: number) {
  const source = parseRgb(from);
  const target = parseRgb(to);
  return `#${toHex(source.r + (target.r - source.r) * ratio)}${toHex(source.g + (target.g - source.g) * ratio)}${toHex(source.b + (target.b - source.b) * ratio)}`;
}

function withAlpha(hex: string, alpha: number) {
  const { r, g, b } = parseRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}

function normalizePalette(palette: ThemePalette): ThemePalette {
  return {
    background: normalizeHex(palette.background),
    backgroundElevated: normalizeHex(palette.backgroundElevated),
    backgroundMuted: normalizeHex(palette.backgroundMuted),
    surface: normalizeHex(palette.surface),
    border: normalizeHex(palette.border),
    text: normalizeHex(palette.text),
    textSecondary: normalizeHex(palette.textSecondary),
    textMuted: normalizeHex(palette.textMuted),
    accent: normalizeHex(palette.accent),
    accentSecondary: normalizeHex(palette.accentSecondary),
    success: normalizeHex(palette.success),
    warning: normalizeHex(palette.warning),
    danger: normalizeHex(palette.danger),
    appGradientFrom: normalizeHex(palette.appGradientFrom),
    appGradientTo: normalizeHex(palette.appGradientTo),
    headerGradientFrom: normalizeHex(palette.headerGradientFrom),
    headerGradientTo: normalizeHex(palette.headerGradientTo),
    spotlightGradientFrom: normalizeHex(palette.spotlightGradientFrom),
    spotlightGradientTo: normalizeHex(palette.spotlightGradientTo),
  };
}

function makeThemeDefinition(theme: CustomThemeDefinition, kind: ThemeKind): ThemeDefinition {
  return {
    ...theme,
    kind,
    description: theme.description?.trim() || undefined,
    palette: normalizePalette(theme.palette),
  };
}

export function getThemeCollection(customThemes: CustomThemeDefinition[] = []) {
  return [
    ...BUILT_IN_THEMES,
    ...customThemes.map((theme) => makeThemeDefinition(theme, "custom")),
  ];
}

export function getThemeCollectionByMode(customThemes: CustomThemeDefinition[] = []) {
  const catalog = getThemeCollection(customThemes);
  return {
    light: catalog.filter((theme) => theme.mode === "light"),
    dark: catalog.filter((theme) => theme.mode === "dark"),
  };
}

function getDefaultThemeId(mode: ThemeMode) {
  return mode === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID;
}

function resolveThemeId(mode: ThemeMode, themeId: string, customThemes: CustomThemeDefinition[]) {
  const theme = getThemeCollection(customThemes).find((candidate) => candidate.id === themeId && candidate.mode === mode);
  return theme?.id ?? getDefaultThemeId(mode);
}

export function normalizeAppearanceSettings(input: unknown): AppearanceSettings {
  const parsed = appearanceSettingsInputSchema.safeParse(input);
  if (!parsed.success) {
    return DEFAULT_APPEARANCE_SETTINGS;
  }

  const uniqueCustomThemes = Object.values(
    parsed.data.customThemes.reduce<Record<string, CustomThemeDefinition>>((acc, theme) => {
      acc[theme.id] = makeThemeDefinition(theme, "custom");
      return acc;
    }, {})
  ).map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
    mode: theme.mode,
    palette: theme.palette,
  }));

  return {
    scheme: parsed.data.scheme,
    lightThemeId: resolveThemeId("light", parsed.data.lightThemeId, uniqueCustomThemes),
    darkThemeId: resolveThemeId("dark", parsed.data.darkThemeId, uniqueCustomThemes),
    customThemes: uniqueCustomThemes,
  };
}

export function getAppearanceSettings(rootSettings: unknown) {
  const root = (rootSettings ?? {}) as Record<string, unknown>;
  return normalizeAppearanceSettings(root.appearance);
}

export function resolveThemeDefinition(settings: AppearanceSettings, mode: ThemeMode) {
  const themeId = mode === "light" ? settings.lightThemeId : settings.darkThemeId;
  return getThemeCollection(settings.customThemes).find((theme) => theme.id === themeId && theme.mode === mode)
    ?? BUILT_IN_THEMES.find((theme) => theme.id === getDefaultThemeId(mode))
    ?? BUILT_IN_THEMES[0];
}

export function buildThemeCssVariables(theme: ThemeDefinition) {
  const { palette, mode } = theme;
  const surfaceHover = mixHex(palette.surface, palette.backgroundMuted, mode === "dark" ? 0.35 : 0.55);
  const surfaceActive = mixHex(palette.surface, palette.border, mode === "dark" ? 0.55 : 0.42);
  const borderMuted = mixHex(palette.border, palette.surface, mode === "dark" ? 0.28 : 0.46);
  const graphBackground = mixHex(palette.background, palette.surface, mode === "dark" ? 0.24 : 0.4);
  const elevatedShadow = mode === "dark"
    ? "0 10px 30px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.22)"
    : "0 12px 30px rgba(15, 23, 42, 0.08), 0 2px 8px rgba(15, 23, 42, 0.06)";

  return {
    "--color-bg": palette.background,
    "--color-bg-elevated": palette.backgroundElevated,
    "--color-bg-muted": palette.backgroundMuted,
    "--color-bg-overlay": withAlpha(palette.backgroundElevated, mode === "dark" ? 0.84 : 0.88),
    "--color-bg-graph": graphBackground,
    "--color-surface": palette.surface,
    "--color-surface-hover": surfaceHover,
    "--color-surface-active": surfaceActive,
    "--color-border": palette.border,
    "--color-border-muted": borderMuted,
    "--color-text": palette.text,
    "--color-text-secondary": palette.textSecondary,
    "--color-text-muted": palette.textMuted,
    "--color-accent": palette.accent,
    "--color-accent-hover": mixHex(palette.accent, mode === "dark" ? "#ffffff" : "#000000", mode === "dark" ? 0.08 : 0.12),
    "--color-accent-muted": withAlpha(palette.accent, mode === "dark" ? 0.16 : 0.14),
    "--color-on-accent": mode === "dark" ? "#0c0e14" : "#ffffff",
    "--color-overlay": mode === "dark" ? "rgba(0, 0, 0, 0.6)" : "rgba(15, 23, 42, 0.5)",
    "--color-success": palette.success,
    "--color-success-muted": withAlpha(palette.success, mode === "dark" ? 0.16 : 0.14),
    "--color-warning": palette.warning,
    "--color-warning-muted": withAlpha(palette.warning, mode === "dark" ? 0.18 : 0.16),
    "--color-info": palette.accentSecondary,
    "--color-info-muted": withAlpha(palette.accentSecondary, mode === "dark" ? 0.16 : 0.14),
    "--color-danger": palette.danger,
    "--color-danger-muted": withAlpha(palette.danger, mode === "dark" ? 0.16 : 0.14),
    "--color-priority-urgent": mixHex(palette.danger, mode === "dark" ? "#ffffff" : "#000000", mode === "dark" ? 0.08 : 0.1),
    "--color-priority-high": mixHex(palette.warning, palette.danger, 0.35),
    "--color-priority-medium": palette.warning,
    "--color-priority-low": palette.success,
    "--color-focus-ring": withAlpha(palette.accent, mode === "dark" ? 0.42 : 0.34),
    "--color-node-bg": palette.surface,
    "--color-node-border": palette.border,
    "--color-node-shadow": mode === "dark" ? "rgba(0, 0, 0, 0.28)" : "rgba(15, 23, 42, 0.08)",
    "--color-edge-default": palette.textMuted,
    "--color-edge-blocks": palette.danger,
    "--color-edge-parent": mixHex(palette.accent, palette.danger, 0.5),
    "--color-edge-child": palette.accent,
    "--color-edge-relates": palette.textMuted,
    "--color-grid-line": mixHex(palette.border, palette.background, mode === "dark" ? 0.35 : 0.55),
    "--color-axis-bg": graphBackground,
    "--color-axis-tick": mixHex(palette.textMuted, palette.border, 0.42),
    "--color-axis-border": palette.border,
    "--color-minimap-bg": withAlpha(graphBackground, mode === "dark" ? 0.92 : 0.9),
    "--color-minimap-node": palette.textMuted,
    "--color-minimap-viewport": withAlpha(palette.accent, mode === "dark" ? 0.14 : 0.16),
    "--color-minimap-viewport-border": palette.accent,
    "--shadow-sm": mode === "dark"
      ? "0 1px 2px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.28)"
      : "0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06)",
    "--shadow-md": elevatedShadow,
    "--shadow-lg": mode === "dark"
      ? "0 14px 38px rgba(0, 0, 0, 0.36), 0 4px 12px rgba(0, 0, 0, 0.2)"
      : "0 18px 45px rgba(15, 23, 42, 0.12), 0 5px 14px rgba(15, 23, 42, 0.08)",
    "--shadow-node": mode === "dark"
      ? "0 1px 3px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.22)"
      : "0 1px 3px rgba(15, 23, 42, 0.06), 0 2px 8px rgba(15, 23, 42, 0.05)",
    "--shadow-node-hover": mode === "dark"
      ? "0 8px 24px rgba(0, 0, 0, 0.34), 0 4px 12px rgba(0, 0, 0, 0.24)"
      : "0 10px 26px rgba(15, 23, 42, 0.12), 0 4px 12px rgba(15, 23, 42, 0.08)",
    "--shadow-node-selected": `0 0 0 2px ${palette.accent}, 0 6px 20px ${withAlpha(palette.accent, mode === "dark" ? 0.24 : 0.22)}`,
    "--radius-sm": "6px",
    "--radius-md": "10px",
    "--radius-lg": "14px",
    "--radius-xl": "20px",
    "--gradient-app": `radial-gradient(circle at top left, ${withAlpha(palette.appGradientFrom, mode === "dark" ? 0.2 : 0.18)} 0%, transparent 38%), radial-gradient(circle at top right, ${withAlpha(palette.appGradientTo, mode === "dark" ? 0.18 : 0.16)} 0%, transparent 42%)`,
    "--gradient-header": `linear-gradient(135deg, ${palette.headerGradientFrom} 0%, ${palette.headerGradientTo} 100%)`,
    "--gradient-accent": `linear-gradient(135deg, ${palette.accent} 0%, ${palette.accentSecondary} 100%)`,
    "--gradient-spotlight": `linear-gradient(145deg, ${mixHex(palette.spotlightGradientFrom, palette.surface, mode === "dark" ? 0.22 : 0.14)} 0%, ${palette.surface} 56%, ${mixHex(palette.spotlightGradientTo, palette.backgroundElevated, mode === "dark" ? 0.22 : 0.12)} 100%)`,
  } as Record<string, string>;
}
