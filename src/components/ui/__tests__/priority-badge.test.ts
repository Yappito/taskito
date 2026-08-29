import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import {
  getPriorityLabel,
  getPriorityToken,
  isTaskPriority,
  PriorityBadge,
  priorityLabels,
  priorityTokens,
  TASK_PRIORITIES,
} from "../priority-badge";

describe("priority mapping", () => {
  it("maps every priority to its --color-priority-* token", () => {
    expect(getPriorityToken("urgent")).toBe("var(--color-priority-urgent)");
    expect(getPriorityToken("high")).toBe("var(--color-priority-high)");
    expect(getPriorityToken("medium")).toBe("var(--color-priority-medium)");
    expect(getPriorityToken("low")).toBe("var(--color-priority-low)");
    expect(getPriorityToken("none")).toBe("var(--color-text-muted)");
  });

  it("falls back to the muted token and echoes unknown values", () => {
    expect(getPriorityToken("critical")).toBe("var(--color-text-muted)");
    expect(getPriorityToken("")).toBe("var(--color-text-muted)");
    expect(getPriorityLabel("critical")).toBe("critical");
    expect(isTaskPriority("nope")).toBe(false);
    expect(isTaskPriority("urgent")).toBe(true);
  });

  it("exposes labels for every priority including none", () => {
    for (const priority of TASK_PRIORITIES) {
      expect(getPriorityLabel(priority)).toBe(priorityLabels[priority]);
    }
    expect(priorityLabels.none).toBe("None");
    expect(priorityTokens.none).toBe("var(--color-text-muted)");
  });
});

describe("PriorityBadge", () => {
  it("renders a pill using the priority token for real priorities", () => {
    const markup = renderToStaticMarkup(createElement(PriorityBadge, { priority: "urgent" }));
    expect(markup).toContain("Urgent");
    expect(markup).toContain("var(--color-priority-urgent)");
    expect(markup).toContain("color-mix(in srgb, var(--color-priority-urgent) 14%, transparent)");
  });

  it("hides the none pill by default and handles it explicitly", () => {
    expect(renderToStaticMarkup(createElement(PriorityBadge, { priority: "none" }))).toBe("");
    const withNone = renderToStaticMarkup(
      createElement(PriorityBadge, { priority: "none", showNone: true })
    );
    expect(withNone).toContain("None");
    expect(withNone).toContain("var(--color-text-muted)");
  });
});
