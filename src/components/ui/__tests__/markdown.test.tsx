import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown, safeMarkdownUrl } from "../markdown";

function render(source: string, props: Record<string, unknown> = {}) {
  return renderToStaticMarkup(createElement(Markdown, { source, ...props }));
}

describe("<Markdown> security", () => {
  it("does not render raw <script> blocks", () => {
    const html = render("hello\n\n<script>alert('xss')</script>\n\nbye");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert");
  });

  it("does not render inline raw HTML or event handlers", () => {
    const html = render('hello <img src=x onerror="alert(1)"> world <b onclick="alert(2)">bold</b>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).toContain("hello");
    expect(html).toContain("world");
  });

  it("renders javascript: links inert", () => {
    const html = render("[click me](javascript:alert('xss'))");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("alert");
  });

  it("renders data: images inert", () => {
    const html = render("![tiny](data:image/png;base64,iVBORw0KGgo=)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("data:image");
  });

  it("renders vbscript: and protocol-relative URLs inert", () => {
    const html = render("[a](vbscript:msgbox(1)) [b](//evil.example/x)");
    expect(html).not.toContain("vbscript:");
    expect(html).not.toContain("//evil.example");
  });

  it("keeps ordinary https links with safe rel/target", () => {
    const html = render("[docs](https://example.com/docs)");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('target="_blank"');
  });

  it("refuses cross-origin images even when images are allowed", () => {
    const allowed = render("![same](/logo.png)", { allowImages: true });
    expect(allowed).toContain('src="/logo.png"');
    expect(allowed).toContain('referrerPolicy="no-referrer"');

    const remote = render("![remote](https://evil.example/pixel.png)", { allowImages: true });
    expect(remote).not.toContain("<img");
    const data = render("![data](data:image/svg+xml;base64,AAAA)", { allowImages: true });
    expect(data).not.toContain("<img");
    const protocolRelative = render("![pr](//evil.example/pixel.png)", { allowImages: true });
    expect(protocolRelative).not.toContain("<img");
  });

  it("strips disallowed elements even if a future plugin emits them", () => {
    const html = render("[x](https://example.com)\n\n<form action=\"/\"><input type=\"text\"><button>go</button></form>");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });
});

describe("<Markdown> GFM rendering", () => {
  it("renders tables", () => {
    const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |\n");
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect(html).toContain(">2</td>");
  });

  it("renders bullet and task lists", () => {
    const html = render("- one\n- two\n");
    expect(html).toContain("<ul");
    expect(html).toContain(">one</li>");

    const tasks = render("- [x] done\n- [ ] open\n");
    expect(tasks).toContain("done");
    expect(tasks).toContain("open");
  });

  it("renders fenced code blocks and inline code", () => {
    const html = render("```\nconst x = 1;\n```\nand `inline code` too");
    expect(html).toContain("<pre");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
    expect(html).toContain("inline code");
  });

  it("renders strikethrough, autolinks and blockquotes", () => {
    const html = render("~~gone~~ www.example.com\n\n> quoted text");
    expect(html).toContain("<del>gone</del>");
    expect(html).toContain("quoted text");
  });
});

describe("<Markdown> mention and task-key enrichment", () => {
  const people = [
    { id: "u-ada", name: "Ada Lovelace", email: "ada@taskito.local" },
    { id: "u-kim", name: "Kim Plus", email: "kim+placeholder@example.com" },
  ];

  it("highlights known @mentions with a title showing the user", () => {
    const html = render("ping @ada please", { mentionUsers: people });
    expect(html).toContain("markdown-mention");
    expect(html).toContain('title="Ada Lovelace (ada@taskito.local)"');
    expect(html).toContain("@ada");
  });

  it("highlights the hyphenated-name token for plus-addressed emails", () => {
    const html = render("ping @kim-plus please", { mentionUsers: people });
    expect(html).toContain("markdown-mention");
    expect(html).toContain('data-mention="u-kim"');
  });

  it("leaves unknown @tokens as plain text", () => {
    const html = render("ping @nobody please", { mentionUsers: people });
    expect(html).not.toContain("markdown-mention");
    expect(html).toContain("@nobody");
  });

  it("does not touch @tokens inside code spans and fenced blocks", () => {
    const inline = render("`@ada`", { mentionUsers: people });
    expect(inline).not.toContain("markdown-mention");
    const fenced = render("```\n@ada\n```", { mentionUsers: people });
    expect(fenced).not.toContain("markdown-mention");
  });

  it("auto-links resolvable task keys via resolveTaskKey", () => {
    const html = render("see DEF-12 for context", {
      resolveTaskKey: (taskKey: string) => (taskKey === "DEF-12" ? "task-cuid-1" : null),
    });
    expect(html).toContain('href="?task=task-cuid-1"');
    expect(html).toContain("DEF-12");
  });

  it("leaves task keys as plain text when they do not resolve", () => {
    const html = render("see ABC-99 for context", {
      resolveTaskKey: (taskKey: string) => (taskKey === "DEF-12" ? "task-cuid-1" : null),
    });
    expect(html).not.toContain("markdown-task-link");
    expect(html).toContain("ABC-99");
  });
});

describe("<Markdown> breaks option", () => {
  it("keeps single newlines as hard line breaks when enabled", () => {
    const html = render("line one\nline two", { breaks: true });
    expect(html).toContain("<br");
  });

  it("collapses single newlines to spaces when disabled", () => {
    const html = render("line one\nline two");
    expect(html).not.toContain("<br");
  });
});

describe("safeMarkdownUrl", () => {
  it("allows http, https, mailto and relative URLs", () => {
    expect(safeMarkdownUrl("https://example.com")).toBe("https://example.com");
    expect(safeMarkdownUrl("http://example.com")).toBe("http://example.com");
    expect(safeMarkdownUrl("mailto:a@b.io")).toBe("mailto:a@b.io");
    expect(safeMarkdownUrl("/local/path")).toBe("/local/path");
    expect(safeMarkdownUrl("?task=abc")).toBe("?task=abc");
  });

  it("rejects javascript, data, vbscript and protocol-relative URLs", () => {
    expect(safeMarkdownUrl("javascript:alert(1)")).toBe("");
    expect(safeMarkdownUrl("data:text/html;base64,AAAA")).toBe("");
    expect(safeMarkdownUrl("vbscript:x")).toBe("");
    expect(safeMarkdownUrl("//evil.example/x")).toBe("");
    expect(safeMarkdownUrl("  ")).toBe("");
  });
});

describe("<Markdown> long input performance", () => {
  it("renders a 50k character document within a sane time", () => {
    const chunk = "Lorem ipsum **dolor** sit @ada amet, `code` DEF-42 dolor.\n\n- item one\n- item two\n\n";
    const longSource = chunk.repeat(Math.ceil(50_000 / chunk.length));
    expect(longSource.length).toBeGreaterThanOrEqual(50_000);

    const startedAt = performance.now();
    const html = render(longSource, {
      mentionUsers: [{ id: "u-ada", name: "Ada Lovelace", email: "ada@taskito.local" }],
      resolveTaskKey: () => "task-cuid-1",
    });
    const elapsedMs = performance.now() - startedAt;

    expect(html.length).toBeGreaterThan(longSource.length / 2);
    expect(elapsedMs).toBeLessThan(5000);
  });
});