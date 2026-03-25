# DESIGN_SYSTEM

This document extracts Taskito's UI theming, design system primitives, and recurring visual patterns from the actual UI layer only.

Scope rules used for this extraction:

- Included: theme tokens, CSS variables, Tailwind usage, visual component patterns, layout shells, interaction states, icons.
- Excluded: API routes, database schema, server logic, non-visual business behavior.

## 1. Tailwind Configuration

### Tailwind setup status

Taskito does not have a `tailwind.config.ts` or `tailwind.config.js` file.

It is using Tailwind CSS v4's CSS-first setup instead:

```css
/* src/app/globals.css */
@import "tailwindcss";
```

```js
/* postcss.config.mjs */
/** @type {import('postcss-load-config').Config} */
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
```

### Equivalent Tailwind config note

There is no copy-pasteable `tailwind.config.ts` content to extract, because the project keeps tokens in CSS variables instead of in a JS/TS theme object.

### CSS custom properties

Main source: `src/app/globals.css`

```css
:root {
  --color-bg: #f8fafc;
  --color-bg-elevated: #ffffff;
  --color-bg-muted: #f1f5f9;
  --color-bg-overlay: rgba(255, 255, 255, 0.85);
  --color-bg-graph: #fafbfd;

  --color-surface: #ffffff;
  --color-surface-hover: #f8fafc;
  --color-surface-active: #f1f5f9;

  --color-border: #e2e8f0;
  --color-border-muted: #f1f5f9;

  --color-text: #0f172a;
  --color-text-secondary: #475569;
  --color-text-muted: #94a3b8;

  --color-accent: #6366f1;
  --color-accent-hover: #4f46e5;
  --color-accent-muted: rgba(99, 102, 241, 0.12);

  --color-danger: #ef4444;
  --color-danger-muted: rgba(239, 68, 68, 0.12);

  --color-node-bg: #ffffff;
  --color-node-border: #e2e8f0;
  --color-node-shadow: rgba(15, 23, 42, 0.06);

  --color-edge-default: #94a3b8;

  --color-grid-line: #f1f5f9;
  --color-axis-bg: #f8fafc;
  --color-axis-tick: #cbd5e1;
  --color-axis-border: #e2e8f0;

  --color-minimap-bg: rgba(248, 250, 252, 0.92);
  --color-minimap-node: #94a3b8;
  --color-minimap-viewport: rgba(99, 102, 241, 0.15);
  --color-minimap-viewport-border: #6366f1;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 20px;

  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 3px rgba(15, 23, 42, 0.06);
  --shadow-md: 0 2px 8px rgba(15, 23, 42, 0.06), 0 4px 16px rgba(15, 23, 42, 0.04);
  --shadow-lg: 0 4px 16px rgba(15, 23, 42, 0.08), 0 8px 32px rgba(15, 23, 42, 0.04);
  --shadow-node: 0 1px 3px rgba(15, 23, 42, 0.06), 0 2px 8px rgba(15, 23, 42, 0.04);
  --shadow-node-hover: 0 4px 12px rgba(15, 23, 42, 0.1), 0 8px 24px rgba(15, 23, 42, 0.06);
  --shadow-node-selected: 0 0 0 2px var(--color-accent), 0 4px 16px rgba(99, 102, 241, 0.2);

  --blur-glass: 12px;

  --transition-fast: 120ms ease;
  --transition-normal: 200ms ease;
  --transition-slow: 300ms cubic-bezier(0.4, 0, 0.2, 1);
}

[data-theme="dark"] {
  --color-bg: #0c0e14;
  --color-bg-elevated: #151822;
  --color-bg-muted: #1a1e2e;
  --color-bg-overlay: rgba(21, 24, 34, 0.88);
  --color-bg-graph: #0f1118;

  --color-surface: #1a1e2e;
  --color-surface-hover: #212638;
  --color-surface-active: #2a3042;

  --color-border: #2a3042;
  --color-border-muted: #1e2336;

  --color-text: #e2e8f0;
  --color-text-secondary: #94a3b8;
  --color-text-muted: #64748b;

  --color-accent: #818cf8;
  --color-accent-hover: #6366f1;
  --color-accent-muted: rgba(129, 140, 248, 0.14);

  --color-danger: #f87171;
  --color-danger-muted: rgba(248, 113, 113, 0.14);

  --color-node-bg: #1a1e2e;
  --color-node-border: #2a3042;
  --color-node-shadow: rgba(0, 0, 0, 0.3);

  --color-edge-default: #475569;

  --color-grid-line: #1a1e2e;
  --color-axis-bg: #0f1118;
  --color-axis-tick: #334155;
  --color-axis-border: #2a3042;

  --color-minimap-bg: rgba(15, 17, 24, 0.92);
  --color-minimap-node: #475569;
  --color-minimap-viewport: rgba(129, 140, 248, 0.12);
  --color-minimap-viewport-border: #818cf8;

  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.2), 0 1px 3px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 2px 8px rgba(0, 0, 0, 0.25), 0 4px 16px rgba(0, 0, 0, 0.2);
  --shadow-lg: 0 4px 16px rgba(0, 0, 0, 0.3), 0 8px 32px rgba(0, 0, 0, 0.2);
  --shadow-node: 0 1px 3px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.2);
  --shadow-node-hover: 0 4px 12px rgba(0, 0, 0, 0.35), 0 8px 24px rgba(0, 0, 0, 0.25);
  --shadow-node-selected: 0 0 0 2px var(--color-accent), 0 4px 16px rgba(129, 140, 248, 0.25);
}
```

### Dark mode strategy

- Strategy: custom attribute-based theming via `data-theme`.
- Source: `src/components/ui/theme-provider.tsx`
- Supported modes: `light`, `dark`, `system`
- Persistence: `localStorage` key `taskito-theme`
- System mode: listens to `prefers-color-scheme: dark`
- Browser color-scheme integration:

```css
html {
  color-scheme: light;
}

[data-theme="dark"] {
  color-scheme: dark;
}
```

### Global utilities and custom classes

Source: `src/app/globals.css`

```css
body,
body * {
  transition-property: background-color, border-color, color, fill, stroke, box-shadow;
  transition-duration: 120ms;
  transition-timing-function: ease;
}

.no-theme-transition,
.no-theme-transition * {
  transition: none !important;
}

.graph-node {
  cursor: pointer;
  transition: filter 150ms ease;
}

.graph-node:hover {
  filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.1));
}

.connection-port {
  opacity: 0;
  transition: opacity 150ms ease;
}

.graph-node:hover .connection-port {
  opacity: 1;
}

.edge-flow-animated {
  animation: flow 1s linear infinite;
}

.pulse-warning {
  animation: pulse-warning 2s ease-in-out infinite;
  border-color: #f59e0b !important;
}

.pulse-critical {
  animation: pulse-critical 1.5s ease-in-out infinite;
  border-color: #ef4444 !important;
}
```

## 2. Color Palette

### Core theme palette

| Token | Light | Dark | Notes |
| --- | --- | --- | --- |
| `--color-bg` | `#f8fafc` | `#0c0e14` | App/page background |
| `--color-bg-elevated` | `#ffffff` | `#151822` | Elevated toolbar background |
| `--color-bg-muted` | `#f1f5f9` | `#1a1e2e` | Muted surfaces, tab rails, placeholders |
| `--color-bg-overlay` | `rgba(255,255,255,0.85)` | `rgba(21,24,34,0.88)` | Glass/overlay surface |
| `--color-surface` | `#ffffff` | `#1a1e2e` | Cards, inputs, panels |
| `--color-surface-hover` | `#f8fafc` | `#212638` | Hover state for cards and list rows |
| `--color-surface-active` | `#f1f5f9` | `#2a3042` | Secondary active state |
| `--color-border` | `#e2e8f0` | `#2a3042` | Primary border |
| `--color-border-muted` | `#f1f5f9` | `#1e2336` | Subtle outlines |
| `--color-text` | `#0f172a` | `#e2e8f0` | Primary text |
| `--color-text-secondary` | `#475569` | `#94a3b8` | Secondary text |
| `--color-text-muted` | `#94a3b8` | `#64748b` | Metadata and placeholders |
| `--color-accent` | `#6366f1` | `#818cf8` | Primary brand/accent |
| `--color-accent-hover` | `#4f46e5` | `#6366f1` | Primary hover |
| `--color-accent-muted` | `rgba(99, 102, 241, 0.12)` | `rgba(129, 140, 248, 0.14)` | Accent-selected backgrounds |
| `--color-danger` | `#ef4444` | `#f87171` | Destructive/error |
| `--color-danger-muted` | `rgba(239, 68, 68, 0.12)` | `rgba(248, 113, 113, 0.14)` | Error/destructive background |

### Semantic colors actually present

- Primary: `--color-accent`
- Secondary: not defined as a dedicated token; most secondary UI uses `--color-bg-muted`, `--color-surface-active`, and `--color-text-secondary`
- Accent: `--color-accent`
- Error/destructive: `--color-danger`
- Warning: no global token, but warning states use hardcoded amber values:
  - `#f59e0b` in pulse-warning animation border/shadow
  - `#eab308` as medium priority color in task cards
- High-priority orange: `#f97316`
- Success: no dedicated success token found
- Info: no dedicated info token found

### Background colors

- Page background: `--color-bg`
- Elevated toolbar/header: `--color-bg-elevated`
- Card/panel/input surface: `--color-surface`
- Hovered card/table row: `--color-surface-hover`
- Input/login muted surface: `--color-bg-muted`
- Overlay/glass panel sections: `--color-bg-overlay`
- Graph background: `--color-bg-graph`

### Text colors

- Primary text: `--color-text`
- Secondary text: `--color-text-secondary`
- Muted text: `--color-text-muted`
- Disabled text: typically inherited plus `disabled:opacity-50`, not a dedicated disabled token
- White-on-accent: `white`

### Border colors

- Standard border: `--color-border`
- Subtle border: `--color-border-muted`
- Accent-selected border: `--color-accent`
- Error border blends:

```css
color-mix(in srgb, var(--color-danger) 35%, var(--color-border))
color-mix(in srgb, var(--color-danger) 30%, var(--color-border))
```

### Color scales

No Tailwind-style custom `50-950` color scales are defined in a config file.

The palette is token-based rather than scale-based.

### Graph-specific palette

- Node background: `--color-node-bg`
- Node border: `--color-node-border`
- Node shadow: `--color-node-shadow`
- Edge default: `--color-edge-default`
- Grid line: `--color-grid-line`
- Axis background: `--color-axis-bg`
- Axis tick: `--color-axis-tick`
- Axis border: `--color-axis-border`
- Minimap background: `--color-minimap-bg`
- Minimap node: `--color-minimap-node`
- Minimap viewport: `--color-minimap-viewport`
- Minimap viewport border: `--color-minimap-viewport-border`

## 3. Typography

### Font family

Taskito uses a single primary font:

```tsx
import { Inter } from "next/font/google";

const inter = Inter({ subsets: ["latin"] });
```

Applied in `src/app/layout.tsx`:

```tsx
<body className={inter.className}>
```

No local fonts, serif stack, or dedicated monospace UI text styles were found.

### Font size scale observed

| Class/value | Usage |
| --- | --- |
| `text-[9px]` | Extra-small avatar initials |
| `text-[10px]` | Task keys, badges, metadata, notification counts |
| `text-[11px]` | Compact assignee labels |
| `text-xs` | Labels, tags, helper text, table header text, small actions |
| `text-sm` | Default app UI size: buttons, inputs, rows, cards, navigation |
| `text-lg` | Dialog titles, panel titles |
| `text-xl` | Profile section titles, avatar xl initials |
| `text-2xl` | Auth/settings page heading |

### Font weights observed

| Weight | Tailwind class | Usage |
| --- | --- | --- |
| 500 | `font-medium` | Default emphasis across buttons, rows, cards |
| 600 | `font-semibold` | Titles, tabs, task keys, status headers |
| 700 | `font-bold` | Login title, small count badges, search metadata |

### Line heights

No custom line-height scale is defined in CSS variables or a Tailwind config.

The project mostly relies on Tailwind defaults for `text-sm`, `text-xs`, `text-lg`, and `text-2xl`.

### Custom text treatments

- Uppercase metadata and role chips
- Tight, small metadata tags in `text-[10px]`
- Avatar initials use uppercase with tracking
- Profile section eyebrow text uses aggressive tracking

Examples:

```tsx
className="text-xs font-semibold uppercase tracking-[0.26em]"
className="relative inline-flex ... font-semibold uppercase tracking-[0.08em]"
className="mb-0.5 block text-[10px] font-semibold"
```

## 4. Component Patterns

### Component stack

- Tailwind CSS v4
- `class-variance-authority` for button variants
- `tailwind-merge` + `clsx` via `cn()` helper
- `@radix-ui/react-slot` only for `asChild` composition in Button
- No `components.json`
- No installed shadcn/ui registry detected
- One custom dialog wrapper is intentionally written with a shadcn-like API, but it is still a custom implementation

Reference files:

- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/select.tsx`
- `src/components/ui/badge.tsx`
- `src/components/ui/dialog.tsx`
- `src/components/ui/theme-provider.tsx`
- `src/components/ui/theme-toggle.tsx`

### Button variants

Source: `src/components/ui/button.tsx`

Base class:

```ts
"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0"
```

Variants:

```ts
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-[var(--color-accent)] text-white shadow hover:bg-[var(--color-accent-hover)]",
        destructive: "bg-[var(--color-danger)] text-white shadow-sm hover:opacity-90",
        outline: "border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] shadow-sm hover:bg-[var(--color-surface-hover)]",
        secondary: "bg-[var(--color-bg-muted)] text-[var(--color-text)] shadow-sm hover:bg-[var(--color-surface-active)]",
        ghost: "text-[var(--color-text)] hover:bg-[var(--color-surface-hover)]",
        link: "text-[var(--color-accent)] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);
```

### Panel/card styling

Common panel recipe:

```tsx
className="rounded-xl border p-3"
style={{
  backgroundColor: "var(--color-surface)",
  borderColor: "var(--color-border)",
  boxShadow: "var(--shadow-sm)",
}}
```

Common task card recipe:

```tsx
className="cursor-pointer rounded-lg border p-3 shadow-sm transition-colors transition-shadow"
style={{
  backgroundColor: "var(--color-surface)",
  borderColor: "var(--color-border)",
  color: "var(--color-text)",
}}
```

Examples:

- Task card: `src/components/task/task-card.tsx`
- Filter panel: `src/components/task/task-view-filters.tsx`
- Bulk action bar: `src/components/task/bulk-action-bar.tsx`
- Notification dropdown: `src/components/ui/notification-center.tsx`

### Form input styling

Reusable input:

```ts
"flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
```

Reusable select:

```ts
"flex h-9 w-full rounded-md border px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50"
```

Inline surface styling for both:

```ts
style={{
  backgroundColor: "var(--color-surface)",
  borderColor: "var(--color-border)",
  color: "var(--color-text)",
}}
```

Large textarea/edit-field pattern used in dialogs and task detail:

```tsx
className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2"
style={{
  backgroundColor: "var(--color-surface)",
  borderColor: "var(--color-border)",
  color: "var(--color-text)",
}}
```

Login form inputs use a slightly different muted-surface treatment:

```tsx
className="mt-1 block w-full rounded-lg px-3 py-2 text-sm outline-none transition-shadow"
style={{
  backgroundColor: "var(--color-bg-muted)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
}}
```

### Badge/tag styling

Generic badge:

```tsx
className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium"
```

Behavior:

- Default: accent-muted background, accent text
- Destructive: danger-muted background, danger text
- Outline: transparent background, border, secondary text

Status badge:

```tsx
className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
style={{
  backgroundColor: `${color}20`,
  color: color,
}}
```

Tag chips across list/search/task card patterns:

```tsx
className="rounded px-1.5 py-0.5 text-xs"
style={{
  backgroundColor: `${tag.color}20`,
  color: tag.color,
}}
```

### Table styling

Main table source: `src/components/task/list-view.tsx`

Header row:

```tsx
className="border-b text-left text-xs font-medium uppercase"
style={{
  backgroundColor: "var(--color-bg-muted)",
  borderColor: "var(--color-border)",
  color: "var(--color-text-muted)",
}}
```

Header cell spacing:

```tsx
className="px-4 py-3"
```

Body rows:

```tsx
className="cursor-pointer border-b transition-colors"
style={{ borderColor: "var(--color-border)" }}
```

Row states:

- Hover: `var(--color-surface-hover)`
- Selected: `var(--color-accent-muted)`
- Alert rows can also receive `pulse-warning` or `pulse-critical`

### Modal/dialog styling

Source: `src/components/ui/dialog.tsx`

Overlay:

```tsx
className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
```

Container shell:

```tsx
className="fixed inset-0 z-50 flex items-center justify-center p-4"
```

Panel:

```tsx
className="relative w-full max-w-lg rounded-lg p-6 shadow-xl"
style={{
  backgroundColor: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  color: "var(--color-text)",
}}
```

Search modal uses a more polished variant:

```tsx
className="fixed left-1/2 top-[15%] z-50 w-full max-w-xl -translate-x-1/2"
```

With inner panel:

```tsx
className="rounded-xl"
style={{
  backgroundColor: "var(--color-surface)",
  border: "1px solid var(--color-border)",
  boxShadow: "var(--shadow-lg)",
}}
```

### Toast/notification styling

No toast library or toast component was found.

What exists instead:

- Notification dropdown center: `src/components/ui/notification-center.tsx`
- Inline error banners: reused throughout list view, board view, task detail

Notification dropdown shell:

```tsx
className="absolute right-0 z-50 mt-2 w-[24rem] rounded-xl border p-3 shadow-lg"
style={{
  backgroundColor: "var(--color-surface)",
  borderColor: "var(--color-border)",
}}
```

Unread counter:

```tsx
className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-bold"
style={{ backgroundColor: "var(--color-danger)", color: "white" }}
```

Error banner recipe:

```tsx
className="rounded-lg border px-3 py-2 text-sm"
style={{
  backgroundColor: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
  borderColor: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))",
  color: "var(--color-danger)",
}}
```

### Sidebar/navigation patterns

There is no left sidebar shell in the main app.

The main navigation pattern is a sticky top header plus a project-scoped toolbar:

- Global top navbar: `src/app/(dashboard)/layout.tsx`
- Project toolbar and view switcher: `src/app/(dashboard)/[projectSlug]/page.tsx`
- Settings uses segmented tabs, not sidebar nav: `src/app/(dashboard)/settings/page.tsx`

Top navbar:

```tsx
className="sticky top-0 z-30 border-b backdrop-blur"
style={{
  backgroundColor: "var(--color-bg-overlay)",
  borderColor: "var(--color-border)",
}}
```

View switch rail:

```tsx
className="ml-4 flex rounded-lg p-0.5"
style={{ backgroundColor: "var(--color-bg-muted)" }}
```

Active view button:

```tsx
className="rounded-md px-3 py-1 text-sm capitalize transition-colors font-medium"
style={{
  backgroundColor: "var(--color-surface)",
  color: "var(--color-text)",
  boxShadow: "var(--shadow-sm)",
}}
```

## 5. Layout Patterns

### Overall shell

- App shell: sticky top bar + content below
- Project pages: full width, no main max-width wrapper
- Settings: centered content container with constrained width
- Auth page: centered single-card layout
- Task detail: fixed right side sheet

### Key layout structures

Dashboard shell:

```tsx
<div className="min-h-screen" style={{ backgroundColor: "var(--color-bg)" }}>
  <header className="sticky top-0 z-30 border-b backdrop-blur">...</header>
  <main>{children}</main>
</div>
```

Project toolbar:

```tsx
className="flex items-center justify-between border-b px-4 py-2"
```

Settings container:

```tsx
className="mx-auto max-w-5xl px-4 py-8"
```

Task detail side panel:

```tsx
className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l shadow-xl backdrop-blur-md"
```

Login card:

```tsx
className="w-full max-w-sm rounded-xl p-8"
```

Search modal width:

```tsx
className="w-full max-w-xl"
```

Notification panel width:

```tsx
className="w-[24rem]"
```

Project switcher width:

```tsx
className="min-w-[15rem]"
```

Board column width:

```tsx
className="w-72 shrink-0"
```

### Spacing system in practice

Most reused spacing values:

- Outer page padding: `px-4`, `py-2`, `py-8`, `p-4`
- Panel padding: `p-3`, `p-4`, `p-6`, `p-8`
- Control padding: `px-3 py-2`, `px-4 py-2`, `px-2.5 py-1`
- Gaps: `gap-1`, `gap-1.5`, `gap-2`, `gap-3`, `gap-4`, `gap-6`

### Radius system in practice

Theme token radii:

- `--radius-sm: 6px`
- `--radius-md: 10px`
- `--radius-lg: 14px`
- `--radius-xl: 20px`

Observed Tailwind radius usage:

- `rounded-md`: primary control radius
- `rounded-lg`: cards, dropdowns, rows, modals
- `rounded-xl`: panels, dropdown wrappers, login card, filter bars
- `rounded-2xl` and `rounded-3xl`: profile/settings surfaces
- `rounded-full`: badges, counters, avatars, chip filters

### Responsive patterns

No custom breakpoints were defined. The app appears to use Tailwind defaults.

Observed responsive prefixes:

- `md:`
- `lg:`
- `xl:`

Examples:

```tsx
className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between"
className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between"
className="grid gap-2 md:grid-cols-2 xl:flex xl:flex-wrap xl:items-center"
className="fixed bottom-6 right-6 ... md:hidden"
className="hidden md:inline-flex"
className="grid gap-6 lg:grid-cols-[1.05fr_1.25fr]"
```

## 6. Interaction Patterns

### Hover and focus behavior

Common hover pattern:

- Muted surfaces shift to `var(--color-surface-hover)`
- Accent buttons shift to `var(--color-accent-hover)`
- Some small nav/action links use `hover:opacity-80`

Examples:

```tsx
hover:bg-[var(--color-accent-hover)]
hover:bg-[var(--color-surface-hover)]
hover:underline
hover:opacity-80
```

Focus patterns:

- Inputs/buttons commonly use `focus-visible:outline-none`
- Inputs/selects commonly use `focus-visible:ring-1`
- Larger textareas/forms sometimes use `focus:ring-2`
- Login inputs apply inline focus glow:

```tsx
event.currentTarget.style.boxShadow = "0 0 0 2px var(--color-accent)";
```

### Transition durations and easing

Global tokens:

```css
--transition-fast: 120ms ease;
--transition-normal: 200ms ease;
--transition-slow: 300ms cubic-bezier(0.4, 0, 0.2, 1);
```

Actual recurring component usage:

- `transition-colors`
- `transition-shadow`
- `transition-shadow` on auth inputs
- `transition: background-color 150ms, border-color 150ms` for board columns
- Theme transitions applied globally to `body, body *`

### Loading states

Skeleton pattern:

```tsx
className="animate-pulse space-y-2 p-4"
```

Placeholder block pattern:

```tsx
className="h-12 rounded"
style={{ backgroundColor: "var(--color-bg-muted)" }}
```

Other loading examples:

- Board skeleton columns: `w-72 shrink-0 animate-pulse rounded-lg p-4`
- Task detail skeleton: `animate-pulse space-y-4`
- Search spinner:

```tsx
className="h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"
style={{ borderColor: "var(--color-accent)", borderTopColor: "transparent" }}
```

### Empty states

Task list:

```tsx
<p className="p-8 text-center" style={{ color: "var(--color-text-muted)" }}>
  No tasks yet. Create one!
</p>
```

Notifications:

```tsx
<p className="py-6 text-center text-xs" style={{ color: "var(--color-text-muted)" }}>
  No notifications yet
</p>
```

Search modal empty states:

- `Open a project first to search its tasks`
- `Searching...`
- `No results found`
- `Type to search tasks...`

Board drop target empty state during drag:

```tsx
className="flex h-12 items-center justify-center rounded-lg border-2 border-dashed text-xs"
```

### Special interaction patterns

- Theme toggle cycles `light -> dark -> system`
- Global search opens with `Cmd+K` / `Ctrl+K`
- Board view uses custom pointer-driven drag preview and dashed drop zones
- Due-date alerts pulse with warning/critical animations
- Search results and table rows use hover-selected surface fills rather than scale/zoom motion

## 7. Icons

### Icon library

Installed icon package: `lucide-react`

Actual usage found in UI code:

- `Sun`
- `Moon`
- `Monitor`

Source: `src/components/ui/theme-toggle.tsx`

```tsx
import { Moon, Sun, Monitor } from "lucide-react";
```

### Icon sizing conventions

- Lucide icons are explicitly rendered at `size={16}` in theme toggle
- Button base assumes inline SVG icons should be `size-4`

```ts
"[&_svg]:size-4 [&_svg]:shrink-0"
```

- Search UI also uses custom inline SVG icons with `h-4 w-4` and `h-5 w-5`
- Some priority markers are text glyphs, not icon components:
  - `⬆⬆`
  - `⬆`
  - `➡`
  - `⬇`
- Some actions use plain text symbols such as `+` and `✕`

### Non-library icon usage

- Search icon is an inline SVG, not Lucide
- Graph view uses custom SVG drawing extensively for nodes, minimap, edges, and axes
- Notification center uses text-only UI, not icon-led affordances

## Reference File Paths

### Theme and root styling

- `src/app/globals.css`
- `src/app/layout.tsx`
- `postcss.config.mjs`

### UI primitives

- `src/components/ui/button.tsx`
- `src/components/ui/input.tsx`
- `src/components/ui/select.tsx`
- `src/components/ui/badge.tsx`
- `src/components/ui/dialog.tsx`
- `src/components/ui/avatar.tsx`
- `src/components/ui/theme-provider.tsx`
- `src/components/ui/theme-toggle.tsx`
- `src/components/ui/project-switcher.tsx`
- `src/components/ui/search-modal.tsx`
- `src/components/ui/notification-center.tsx`
- `src/components/ui/task-search-input.tsx`

### Task surfaces and layouts

- `src/components/task/task-card.tsx`
- `src/components/task/status-badge.tsx`
- `src/components/task/list-view.tsx`
- `src/components/task/board-view.tsx`
- `src/components/task/task-detail.tsx`
- `src/components/task/bulk-action-bar.tsx`
- `src/components/task/task-view-filters.tsx`
- `src/components/task/quick-add.tsx`

### Page shells

- `src/app/(dashboard)/layout.tsx`
- `src/app/(dashboard)/[projectSlug]/page.tsx`
- `src/app/(dashboard)/settings/page.tsx`
- `src/components/auth/login-form.tsx`

## Replication Notes For WalletCat

If the goal is visual alignment rather than literal component sharing, the minimum viable carry-over is:

1. Reuse the same CSS variable block from `src/app/globals.css`.
2. Keep the same attribute-based theme model: `data-theme="light|dark"` with `system` resolution.
3. Use Inter as the only UI font.
4. Reuse Taskito's button, input, badge, dialog, and panel class recipes.
5. Keep the same spacing rhythm: `px-4`, `p-3`, `rounded-lg` and `rounded-xl`, soft borders, low-contrast surfaces.
6. Use accent-indigo plus slate neutrals as the dominant identity, with danger red reserved for destructive and overdue states.
7. Prefer top-nav plus toolbar patterns over a heavy permanent sidebar unless WalletCat genuinely needs one.
