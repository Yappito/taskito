"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppearanceSettings, CustomThemeDefinition, ThemePalette } from "@/lib/types";
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  getThemeCollectionByMode,
  resolveThemeDefinition,
  type ThemeDefinition,
  type ThemeMode,
  type ThemePreference,
} from "@/lib/themes";
import { trpc } from "@/lib/trpc-client";
import { useTheme } from "@/components/ui/theme-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogControlled as Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type ThemeEditorState = {
  id: string;
  name: string;
  description: string;
  mode: ThemeMode;
  palette: ThemePalette;
};

const paletteFieldGroups: Array<{ title: string; fields: Array<{ key: keyof ThemePalette; label: string }> }> = [
  {
    title: "Core surfaces",
    fields: [
      { key: "background", label: "Page background" },
      { key: "backgroundElevated", label: "Elevated background" },
      { key: "backgroundMuted", label: "Muted background" },
      { key: "surface", label: "Cards and panels" },
      { key: "border", label: "Borders" },
    ],
  },
  {
    title: "Typography and status",
    fields: [
      { key: "text", label: "Primary text" },
      { key: "textSecondary", label: "Secondary text" },
      { key: "textMuted", label: "Muted text" },
      { key: "success", label: "Success" },
      { key: "warning", label: "Warning" },
      { key: "danger", label: "Danger" },
    ],
  },
  {
    title: "Brand and gradients",
    fields: [
      { key: "accent", label: "Primary accent" },
      { key: "accentSecondary", label: "Secondary accent" },
      { key: "appGradientFrom", label: "Workspace glow from" },
      { key: "appGradientTo", label: "Workspace glow to" },
      { key: "headerGradientFrom", label: "Header mark from" },
      { key: "headerGradientTo", label: "Header mark to" },
      { key: "spotlightGradientFrom", label: "Spotlight card from" },
      { key: "spotlightGradientTo", label: "Spotlight card to" },
    ],
  },
];

function createThemeId() {
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function toEditorState(theme: ThemeDefinition | CustomThemeDefinition, nextId?: string): ThemeEditorState {
  return {
    id: nextId ?? theme.id,
    name: theme.name,
    description: theme.description ?? "",
    mode: theme.mode,
    palette: { ...theme.palette },
  };
}

function ensureThemeForMode(appearance: AppearanceSettings, mode: ThemeMode) {
  const themeId = mode === "light" ? appearance.lightThemeId : appearance.darkThemeId;
  const catalog = getThemeCollectionByMode(appearance.customThemes)[mode];
  if (catalog.some((theme) => theme.id === themeId)) {
    return appearance;
  }

  return {
    ...appearance,
    [mode === "light" ? "lightThemeId" : "darkThemeId"]: mode === "light" ? DEFAULT_LIGHT_THEME_ID : DEFAULT_DARK_THEME_ID,
  };
}

function ThemePreviewCard({
  theme,
  selected,
  onSelect,
  onEdit,
  onDelete,
}: {
  theme: ThemeDefinition;
  selected: boolean;
  onSelect: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      className="rounded-3xl border p-3"
      style={{
        borderColor: selected ? "var(--color-accent)" : "var(--color-border)",
        backgroundColor: "var(--color-surface)",
        boxShadow: selected ? "var(--shadow-md)" : "var(--shadow-sm)",
      }}
    >
      <button
        type="button"
        onClick={onSelect}
        className="w-full text-left"
      >
        <div
          className="overflow-hidden rounded-2xl border"
          style={{
            borderColor: theme.palette.border,
            background: `linear-gradient(145deg, ${theme.palette.spotlightGradientFrom} 0%, ${theme.palette.surface} 56%, ${theme.palette.spotlightGradientTo} 100%)`,
          }}
        >
          <div className="flex items-center justify-between px-4 py-3" style={{ background: `linear-gradient(135deg, ${theme.palette.headerGradientFrom} 0%, ${theme.palette.headerGradientTo} 100%)` }}>
            <div className="rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-white/90">
              {theme.mode}
            </div>
            {theme.kind === "custom" && (
              <div className="rounded-full bg-white/16 px-2 py-0.5 text-[11px] font-medium text-white">Custom</div>
            )}
          </div>
          <div className="space-y-3 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold" style={{ color: theme.palette.text }}>{theme.name}</div>
                <div className="mt-1 text-xs leading-5" style={{ color: theme.palette.textSecondary }}>{theme.description ?? "Customizable color system"}</div>
              </div>
              <div className="h-8 w-8 rounded-xl" style={{ background: `linear-gradient(135deg, ${theme.palette.accent} 0%, ${theme.palette.accentSecondary} 100%)` }} />
            </div>
            <div className="grid grid-cols-5 gap-2">
              {[
                theme.palette.background,
                theme.palette.surface,
                theme.palette.accent,
                theme.palette.accentSecondary,
                theme.palette.danger,
              ].map((color) => (
                <div key={color} className="h-8 rounded-xl border" style={{ backgroundColor: color, borderColor: theme.palette.border }} />
              ))}
            </div>
          </div>
        </div>
      </button>
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs font-medium" style={{ color: selected ? "var(--color-accent)" : "var(--color-text-muted)" }}>
          {selected ? "Selected" : "Available"}
        </span>
        <div className="flex gap-2">
          {onEdit && <Button type="button" size="sm" variant="outline" onClick={onEdit}>Edit</Button>}
          {onDelete && <Button type="button" size="sm" variant="outline" onClick={onDelete}>Delete</Button>}
        </div>
      </div>
    </div>
  );
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="rounded-2xl border p-3" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)" }}>
      <div className="text-sm font-medium" style={{ color: "var(--color-text)" }}>{label}</div>
      <div className="mt-3 flex items-center gap-3">
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value.toLowerCase())}
          className="h-10 w-14 cursor-pointer rounded-lg border-0 bg-transparent p-0"
        />
        <Input value={value} onChange={(event) => onChange(event.target.value)} pattern="^#[0-9a-fA-F]{6}$" required className="font-mono" />
      </div>
    </label>
  );
}

export function AppearanceSettingsSection() {
  const utils = trpc.useUtils();
  const { appearance, setAppearance, activeTheme } = useTheme();
  const { data } = trpc.user.appearance.useQuery(undefined, {
    initialData: appearance,
  });
  const updateAppearance = trpc.user.updateAppearance.useMutation({
    onSuccess: async (nextAppearance) => {
      setAppearance(nextAppearance);
      await utils.user.appearance.invalidate();
    },
  });

  const [editorOpen, setEditorOpen] = useState(false);
  const [editorState, setEditorState] = useState<ThemeEditorState | null>(null);
  const currentAppearance = data ?? appearance;

  useEffect(() => {
    if (data) {
      setAppearance(data);
    }
  }, [data, setAppearance]);

  const themesByMode = useMemo(() => getThemeCollectionByMode(currentAppearance.customThemes), [currentAppearance.customThemes]);
  const lightTheme = resolveThemeDefinition(currentAppearance, "light");
  const darkTheme = resolveThemeDefinition(currentAppearance, "dark");

  async function persistAppearance(nextAppearance: AppearanceSettings) {
    const previous = currentAppearance;
    setAppearance(nextAppearance);
    try {
      await updateAppearance.mutateAsync(nextAppearance);
    } catch {
      setAppearance(previous);
    }
  }

  function handleSchemeChange(scheme: ThemePreference) {
    void persistAppearance({
      ...currentAppearance,
      scheme,
    });
  }

  function handleThemeSelect(mode: ThemeMode, themeId: string) {
    void persistAppearance({
      ...currentAppearance,
      [mode === "light" ? "lightThemeId" : "darkThemeId"]: themeId,
    });
  }

  function openCreateTheme(mode: ThemeMode) {
    const baseTheme = mode === "light" ? lightTheme : darkTheme;
    setEditorState({
      ...toEditorState(baseTheme, createThemeId()),
      name: `${baseTheme.name} Custom`,
    });
    setEditorOpen(true);
  }

  function openEditTheme(theme: CustomThemeDefinition) {
    setEditorState(toEditorState(theme));
    setEditorOpen(true);
  }

  function handleDeleteTheme(theme: ThemeDefinition) {
    const nextAppearance = ensureThemeForMode({
      ...currentAppearance,
      customThemes: currentAppearance.customThemes.filter((candidate) => candidate.id !== theme.id),
    }, theme.mode);

    void persistAppearance(nextAppearance);
  }

  async function handleSaveTheme() {
    if (!editorState) return;

    const customTheme: CustomThemeDefinition = {
      id: editorState.id,
      name: editorState.name.trim(),
      description: editorState.description.trim() || undefined,
      mode: editorState.mode,
      palette: editorState.palette,
    };

    const nextCustomThemes = [
      ...currentAppearance.customThemes.filter((theme) => theme.id !== customTheme.id),
      customTheme,
    ];

    const nextAppearance = {
      ...currentAppearance,
      customThemes: nextCustomThemes,
      [customTheme.mode === "light" ? "lightThemeId" : "darkThemeId"]: customTheme.id,
    };

    await persistAppearance(nextAppearance);
    setEditorOpen(false);
    setEditorState(null);
  }

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-3xl border" style={{ borderColor: "var(--color-border)", background: "var(--gradient-spotlight)" }}>
        <div className="grid gap-6 px-6 py-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em]" style={{ color: "var(--color-text-muted)" }}>Appearance</p>
            <h2 className="mt-2 text-2xl font-semibold" style={{ color: "var(--color-text)" }}>Theme collection and custom palettes</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6" style={{ color: "var(--color-text-secondary)" }}>
              Pick separate light and dark themes, keep system switching if you want, and create your own palette with custom workspace, header, accent, and spotlight gradients.
            </p>
          </div>
          <div className="rounded-3xl border p-5" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-overlay)", boxShadow: "var(--shadow-md)" }}>
            <div className="text-xs font-semibold uppercase tracking-[0.2em]" style={{ color: "var(--color-text-muted)" }}>Live preview</div>
            <div className="mt-4 overflow-hidden rounded-2xl border" style={{ borderColor: activeTheme.palette.border }}>
              <div className="flex items-center justify-between px-4 py-3" style={{ background: `linear-gradient(135deg, ${activeTheme.palette.headerGradientFrom} 0%, ${activeTheme.palette.headerGradientTo} 100%)` }}>
                <span className="text-sm font-semibold text-white">{activeTheme.name}</span>
                <span className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-medium text-white/90">{currentAppearance.scheme}</span>
              </div>
              <div className="space-y-4 px-4 py-4" style={{ background: `linear-gradient(145deg, ${activeTheme.palette.spotlightGradientFrom} 0%, ${activeTheme.palette.surface} 58%, ${activeTheme.palette.spotlightGradientTo} 100%)` }}>
                <div>
                  <div className="text-sm font-semibold" style={{ color: activeTheme.palette.text }}>Current shell styling</div>
                  <div className="mt-1 text-xs leading-5" style={{ color: activeTheme.palette.textSecondary }}>Header mark, page glow, surfaces, text hierarchy, and status colors follow this theme.</div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="rounded-2xl border p-3" style={{ borderColor: activeTheme.palette.border, backgroundColor: activeTheme.palette.background }}>
                    <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: activeTheme.palette.textMuted }}>Background</div>
                    <div className="mt-2 h-8 rounded-xl" style={{ backgroundColor: activeTheme.palette.background }} />
                  </div>
                  <div className="rounded-2xl border p-3" style={{ borderColor: activeTheme.palette.border, backgroundColor: activeTheme.palette.surface }}>
                    <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: activeTheme.palette.textMuted }}>Surface</div>
                    <div className="mt-2 h-8 rounded-xl" style={{ backgroundColor: activeTheme.palette.surface }} />
                  </div>
                  <div className="rounded-2xl border p-3" style={{ borderColor: activeTheme.palette.border, backgroundColor: activeTheme.palette.backgroundElevated }}>
                    <div className="text-[11px] uppercase tracking-[0.18em]" style={{ color: activeTheme.palette.textMuted }}>Accent</div>
                    <div className="mt-2 h-8 rounded-xl" style={{ background: `linear-gradient(135deg, ${activeTheme.palette.accent} 0%, ${activeTheme.palette.accentSecondary} 100%)` }} />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
        <div className="flex flex-wrap gap-3">
          {([
            ["system", "Follow system"],
            ["light", "Always light"],
            ["dark", "Always dark"],
          ] as const).map(([scheme, label]) => (
            <button
              key={scheme}
              type="button"
              onClick={() => handleSchemeChange(scheme)}
              className="rounded-full border px-4 py-2 text-sm font-medium transition-colors"
              style={{
                borderColor: currentAppearance.scheme === scheme ? "var(--color-accent)" : "var(--color-border)",
                backgroundColor: currentAppearance.scheme === scheme ? "var(--color-accent-muted)" : "var(--color-bg-overlay)",
                color: currentAppearance.scheme === scheme ? "var(--color-accent)" : "var(--color-text-secondary)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {updateAppearance.error && (
          <p className="mt-4 text-sm" style={{ color: "var(--color-danger)" }}>{updateAppearance.error.message}</p>
        )}
        {updateAppearance.isSuccess && !updateAppearance.isPending && (
          <p className="mt-4 text-sm" style={{ color: "var(--color-accent)" }}>Appearance saved.</p>
        )}
      </section>

      {(["light", "dark"] as const).map((mode) => {
        const selectedId = mode === "light" ? currentAppearance.lightThemeId : currentAppearance.darkThemeId;
        return (
          <section key={mode} className="space-y-4 rounded-3xl border p-6" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-lg font-semibold capitalize" style={{ color: "var(--color-text)" }}>{mode} theme</h3>
                <p className="mt-1 text-sm" style={{ color: "var(--color-text-secondary)" }}>
                  Choose the {mode} palette used when the app is in {mode} mode.
                </p>
              </div>
              <Button type="button" variant="outline" onClick={() => openCreateTheme(mode)}>
                Create custom {mode} theme
              </Button>
            </div>
            <div className="grid gap-4 xl:grid-cols-4 md:grid-cols-2">
              {themesByMode[mode].map((theme) => (
                <ThemePreviewCard
                  key={theme.id}
                  theme={theme}
                  selected={selectedId === theme.id}
                  onSelect={() => handleThemeSelect(mode, theme.id)}
                  onEdit={theme.kind === "custom" ? () => openEditTheme(theme) : undefined}
                  onDelete={theme.kind === "custom" ? () => handleDeleteTheme(theme) : undefined}
                />
              ))}
            </div>
          </section>
        );
      })}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>{editorState?.id.startsWith("custom-") ? "Custom Theme" : "Edit Theme"}</DialogTitle>
          </DialogHeader>
          {editorState && (
            <form
              className="space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                void handleSaveTheme();
              }}
            >
              <div className="grid gap-4 md:grid-cols-[1fr_1fr_180px]">
                <div>
                  <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Theme name</label>
                  <Input
                    value={editorState.name}
                    maxLength={60}
                    onChange={(event) => setEditorState((current) => current ? { ...current, name: event.target.value } : current)}
                    required
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Description</label>
                  <Input
                    value={editorState.description}
                    maxLength={140}
                    onChange={(event) => setEditorState((current) => current ? { ...current, description: event.target.value } : current)}
                    placeholder="Optional short description"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>Mode</label>
                  <select
                    value={editorState.mode}
                    onChange={(event) => setEditorState((current) => current ? { ...current, mode: event.target.value as ThemeMode } : current)}
                    className="w-full rounded-lg border px-3 py-2 text-sm"
                    style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-muted)", color: "var(--color-text)" }}
                  >
                    <option value="light">light</option>
                    <option value="dark">dark</option>
                  </select>
                </div>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                {paletteFieldGroups.map((group) => (
                  <section key={group.title} className="space-y-3 rounded-3xl border p-4" style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}>
                    <h4 className="text-sm font-semibold" style={{ color: "var(--color-text)" }}>{group.title}</h4>
                    <div className="space-y-3">
                      {group.fields.map((field) => (
                        <ColorField
                          key={field.key}
                          label={field.label}
                          value={editorState.palette[field.key]}
                          onChange={(value) => setEditorState((current) => current ? {
                            ...current,
                            palette: {
                              ...current.palette,
                              [field.key]: value,
                            },
                          } : current)}
                        />
                      ))}
                    </div>
                  </section>
                ))}
              </div>

              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setEditorOpen(false)}>Cancel</Button>
                <Button type="submit" disabled={updateAppearance.isPending || !editorState.name.trim()}>
                  {updateAppearance.isPending ? "Saving..." : "Save Theme"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
