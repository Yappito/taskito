import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import { getTagChipStyle, tagChipBackground, TagBadgeList, type TagLike } from "../tag-badge";

function renderTags(tags: TagLike[], max?: number) {
  return renderToStaticMarkup(
    max !== undefined
      ? createElement(TagBadgeList, { tags, max })
      : createElement(TagBadgeList, { tags })
  );
}

describe("tag-badge chip styles", () => {
  it("builds chip colours with color-mix, not the hex-suffix hack", () => {
    expect(tagChipBackground("#ff0000")).toBe("color-mix(in srgb, #ff0000 12%, transparent)");
    expect(tagChipBackground("#ff0000")).not.toMatch(/20$/);
  });

  it("getTagChipStyle uses color-mix for valid hex colours", () => {
    expect(getTagChipStyle("#00ff00")).toEqual({
      backgroundColor: "color-mix(in srgb, #00ff00 12%, transparent)",
      color: "#00ff00",
    });
    expect(getTagChipStyle(" #abc ")).toEqual({
      backgroundColor: "color-mix(in srgb, #abc 12%, transparent)",
      color: "#abc",
    });
  });

  it("getTagChipStyle falls back to accent tokens for invalid or missing colours", () => {
    const fallback = {
      backgroundColor: "var(--color-accent-muted)",
      color: "var(--color-accent)",
    };
    expect(getTagChipStyle(null)).toEqual(fallback);
    expect(getTagChipStyle(undefined)).toEqual(fallback);
    expect(getTagChipStyle("")).toEqual(fallback);
    expect(getTagChipStyle("not-a-colour")).toEqual(fallback);
    expect(getTagChipStyle("#12345")).toEqual(fallback);
    expect(getTagChipStyle("ff0000")).toEqual(fallback);
  });
});

describe("TagBadgeList", () => {
  const tags: TagLike[] = [
    { name: "bug", color: "#ff0000" },
    { name: "infra", color: "#00ff00" },
    { name: "ux", color: "#0000ff" },
    { name: "docs", color: "#ff00ff" },
    { name: "chore", color: "#ffff00" },
  ];

  it("renders up to max tags plus a +N overflow chip", () => {
    const markup = renderTags(tags, 3);
    expect(markup).toContain("bug");
    expect(markup).toContain("infra");
    expect(markup).toContain("ux");
    expect(markup).not.toContain("docs");
    expect(markup).toContain("+2");
  });

  it("renders every tag when under the limit and no overflow chip", () => {
    const markup = renderTags(tags.slice(0, 2), 3);
    expect(markup).toContain("bug");
    expect(markup).toContain("infra");
    expect(markup).not.toContain("+");
  });

  it("chips carry the color-mix background", () => {
    const markup = renderTags([tags[0]], 3);
    expect(markup).toContain("color-mix(in srgb, #ff0000 12%, transparent)");
  });

  it("defaults max to 3", () => {
    const markup = renderTags(tags);
    expect(markup).toContain("+2");
  });
});
