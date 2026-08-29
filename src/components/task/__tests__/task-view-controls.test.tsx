/*
 * Unit tests for the pure helpers behind the task-view control migration.
 * Uses createElement (not JSX children props) to satisfy eslint rules.
 */
/* eslint-disable react/no-children-prop */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { ariaSortFor, getTagToggleChipStyle, isInteractiveCardTarget } from "../task-view-helpers";
import { ToggleChip } from "../task-view-filters";

describe("ariaSortFor", () => {
  it("returns ascending for the active field sorted asc", () => {
    expect(ariaSortFor("title", "title", "asc")).toBe("ascending");
  });

  it("returns descending for the active field sorted desc", () => {
    expect(ariaSortFor("priority", "priority", "desc")).toBe("descending");
  });

  it("returns none for inactive fields", () => {
    expect(ariaSortFor("title", "dueDate", "asc")).toBe("none");
  });
});

describe("isInteractiveCardTarget", () => {
  it("is false when the event targets the card root itself", () => {
    const root = { closest: () => null } as unknown as EventTarget;
    expect(isInteractiveCardTarget(root, root)).toBe(false);
  });

  it("is true when the target sits inside a control", () => {
    const target = { closest: (selector: string) => (selector.includes("select") ? {} : null) } as unknown as EventTarget;
    expect(isInteractiveCardTarget(target, {} as EventTarget)).toBe(true);
  });

  it("is false for non-element targets without closest", () => {
    expect(isInteractiveCardTarget(null, {} as EventTarget)).toBe(false);
    expect(isInteractiveCardTarget({} as EventTarget, {} as EventTarget)).toBe(false);
  });
});

describe("getTagToggleChipStyle", () => {
  it("deselected chips use neutral surface tokens", () => {
    const style = getTagToggleChipStyle(false, "#ff0000");
    expect(style.backgroundColor).toBe("var(--color-surface)");
    expect(style.borderColor).toBe("var(--color-border)");
    expect(style.color).toBe("var(--color-text-secondary)");
  });

  it("selected chips blend the tag colour via color-mix (no hex-alpha suffix)", () => {
    const style = getTagToggleChipStyle(true, "#ff0000");
    expect(style.backgroundColor).toContain("color-mix(in srgb, #ff0000 12%");
    expect(style.color).toBe("#ff0000");
    expect(style.borderColor).toBe("#ff0000");
  });

  it("falls back to accent tokens for invalid colours", () => {
    const style = getTagToggleChipStyle(true, "not-a-hex");
    expect(style.backgroundColor).toBe("var(--color-accent-muted)");
    expect(style.color).toBe("var(--color-accent)");
  });
});

describe("ToggleChip", () => {
  it("renders a button with aria-pressed and preserves its label", () => {
    const markup = renderToStaticMarkup(
      createElement(ToggleChip, { selected: true, onClick: () => {}, children: "backend" })
    );
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("backend");
    // no focus suppression: the global focus-visible outline must survive
    expect(markup).not.toContain(["outline", "none"].join("-"));
  });

  it("renders aria-pressed=false when unselected", () => {
    const markup = renderToStaticMarkup(
      createElement(ToggleChip, { selected: false, onClick: () => {}, children: "backend" })
    );
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain("var(--color-surface)");
  });
});