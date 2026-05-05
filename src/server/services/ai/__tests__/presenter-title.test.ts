import { describe, expect, it } from "vitest";

import { normalizeAiConversationTitle } from "@/server/services/ai/presenter";

describe("normalizeAiConversationTitle", () => {
  it("strips quotes and trailing punctuation", () => {
    expect(normalizeAiConversationTitle('"Link release tasks together."')).toBe("Link release tasks together");
  });

  it("collapses whitespace and limits length", () => {
    const title = normalizeAiConversationTitle("  This   is   a   deliberately long title that should be trimmed down before it reaches the database because it keeps going and going  ");
    expect(title).not.toMatch(/\s{2,}/);
    expect(title.length).toBeLessThanOrEqual(120);
  });
});
