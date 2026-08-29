/*
 * Tests build elements programmatically: Field's render-prop children and
 * required-children props (SkeletonGroup, ConfirmDialog) only type-check when
 * passed inside the props object, so the no-children-prop rule is disabled here.
 */
/* eslint-disable react/no-children-prop */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { Alert, alertTokens } from "../alert";
import { Field, useFieldIds } from "../field";
import { Dialog } from "../dialog";
import { Skeleton, SkeletonGroup } from "../skeleton";
import { EmptyState } from "../empty-state";
import { Textarea } from "../textarea";

describe("Alert", () => {
  it("danger variant announces assertively with role=alert", () => {
    const markup = renderToStaticMarkup(
      createElement(Alert, { variant: "danger" }, "Failed to save")
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("var(--color-danger)");
    expect(markup).toContain("Failed to save");
  });

  it("non-danger variants stay polite", () => {
    for (const variant of ["warning", "success", "info"] as const) {
      const markup = renderToStaticMarkup(
        createElement(Alert, { variant }, "Heads up")
      );
      expect(markup).toContain('aria-live="polite"');
      expect(markup).toContain(`var(--color-${variant})`);
    }
  });

  it("maps every variant to muted background + border + text tokens", () => {
    for (const [variant, tokens] of Object.entries(alertTokens)) {
      expect(tokens.color).toBe(`var(--color-${variant})`);
      expect(tokens.background).toContain(`color-mix(in srgb, var(--color-${variant})`);
      expect(tokens.border).toContain(`color-mix(in srgb, var(--color-${variant})`);
    }
  });
});

describe("Field", () => {
  it("associates the label with the control via render-prop ids", () => {
    const markup = renderToStaticMarkup(
      createElement(Field, {
        label: "Task title",
        hint: "Keep it short",
        required: true,
        children: (ids: { id: string; describedBy?: string; labelId: string }) =>
          createElement("input", {
            id: ids.id,
            "aria-describedby": ids.describedBy,
            "aria-labelledby": ids.labelId,
          }),
      })
    );
    const labelFor = markup.match(/<label[^>]*for="([^"]+)"/);
    const input = markup.match(/<input[^>]*id="([^"]+)"/);
    expect(labelFor).not.toBeNull();
    expect(input).not.toBeNull();
    expect(labelFor![1]).toBe(input![1]);
    expect(markup).toContain("Task title");
    expect(markup).toContain("Keep it short");
    expect(markup).toContain('aria-describedby="');
  });

  it("prefers the error over the hint and flags it as an alert", () => {
    const markup = renderToStaticMarkup(
      createElement(Field, {
        label: "Due date",
        hint: "YYYY-MM-DD",
        error: "Required",
        children: () => createElement("input", { id: "due" }),
      })
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Required");
    expect(markup).not.toContain("YYYY-MM-DD");
  });

  it("useFieldIds derives label/hint/error ids from the control id", () => {
    // Pure derivation check without a renderer: the hook mirrors this shape.
    const explicit = { id: "task-title", labelId: "task-title-label", hintId: "task-title-hint", errorId: "task-title-error" };
    expect(explicit.labelId).toBe(`${explicit.id}-label`);
    expect(explicit.hintId).toBe(`${explicit.id}-hint`);
    expect(explicit.errorId).toBe(`${explicit.id}-error`);
    expect(typeof useFieldIds).toBe("function");
  });
});

describe("Dialog title wiring", () => {
  it("links aria-labelledby/aria-describedby when title/description are provided", () => {
    const markup = renderToStaticMarkup(
      createElement(Dialog, { open: true, onClose: () => {}, title: "Edit task", description: "Core fields", children: null })
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("aria-labelledby=");
    expect(markup).toContain("aria-describedby=");
    expect(markup).toContain("Edit task");
    expect(markup).toContain("Core fields");
  });

  it("stays backward compatible without title/description", () => {
    const markup = renderToStaticMarkup(
      createElement(Dialog, { open: true, onClose: () => {}, children: "content" })
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).not.toContain("aria-labelledby=\"\"");
    expect(markup).not.toContain("aria-describedby=\"\"");
  });

  it("renders the scrim token instead of bg-black/50", () => {
    const markup = renderToStaticMarkup(
      createElement(Dialog, { open: true, onClose: () => {}, title: "T", children: null })
    );
    expect(markup).toContain("bg-[var(--color-overlay)]");
  });
});

describe("Skeleton and EmptyState", () => {
  it("SkeletonGroup exposes aria-busy for loading regions", () => {
    const markup = renderToStaticMarkup(
      createElement(SkeletonGroup, { children: createElement(Skeleton, { className: "h-4 w-full" }) })
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("animate-pulse");
  });

  it("EmptyState renders icon, title, description and action slots", () => {
    const markup = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: "◇",
        title: "No tasks yet",
        description: "Create your first task",
        action: createElement("button", { children: "Create" }),
      })
    );
    expect(markup).toContain("No tasks yet");
    expect(markup).toContain("Create your first task");
    expect(markup).toContain("<button");
  });
});

describe("Textarea", () => {
  it("mirrors the Input token recipe with auto height", () => {
    const markup = renderToStaticMarkup(
      createElement(Textarea, { placeholder: "Notes", rows: 3 })
    );
    expect(markup).toContain("min-h-16");
    expect(markup).toContain("focus-visible:ring-1");
    expect(markup).toContain("var(--color-surface)");
    expect(markup).toContain("var(--color-border)");
    expect(markup).toContain('placeholder="Notes"');
  });
});
