"use client";

import { useMemo } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { mentionTokensFor } from "@/lib/mentions";

/**
 * Shared markdown renderer for task descriptions, comments and the AI chat.
 *
 * Security posture:
 * - raw HTML is skipped entirely (`skipHtml`)
 * - script/style/iframe/object/embed/form elements are disallowed (belt and
 *   braces on top of skipHtml — markdown itself never produces them, but
 *   rehype plugins upstream could)
 * - every href/src goes through `safeUrlTransform`, which only allows
 *   `http:`, `https:`, `mailto:` and plain relative URLs (no `javascript:`,
 *   `data:`, `vbscript:` or protocol-relative URLs)
 * - images are disabled by default (`allowImages`); when enabled they only
 *   render for same-origin (relative) sources
 * - task-key links and mention highlights are same-document, escaped React
 *   nodes — no raw HTML is ever injected
 */

export interface MarkdownMentionUser {
  id: string;
  name?: string | null;
  email: string;
}

export interface MarkdownProps {
  source: string;
  className?: string;
  /** Project people used to highlight `@mention` tokens. */
  mentionUsers?: readonly MarkdownMentionUser[];
  /**
   * Maps a task key like `DEF-12` to a task id; keys resolving to an id are
   * auto-linked to `?task=<id>` (same document, so the project page's
   * `?task=` handler opens the referenced task).
   */
  resolveTaskKey?: (taskKey: string) => string | null | undefined;
  /** Render unaugmented `![alt](src)` images when they are same-origin relative. */
  allowImages?: boolean;
  /**
   * Treat single newlines as hard line breaks (GitHub-comment style). Use this
   * for plain-text authored content such as comments; leave off for authored
   * markdown like the AI chat.
   */
  breaks?: boolean;
}

const SAFE_URL_PROTOCOLS = new Set(["http", "https", "mailto"]);

/**
 * Only http(s), mailto and scheme-less relative URLs survive. Relative URLs
 * resolve against the current page, so `?task=` style links keep working.
 */
export function safeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("//")) {
    return "";
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (match) {
    return SAFE_URL_PROTOCOLS.has(match[1]!.toLowerCase()) ? trimmed : "";
  }
  return trimmed;
}

function isSameOriginUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("//")) {
    return false;
  }
  // Any explicit scheme (http:, data:, javascript:, mailto:, ...) disqualifies;
  // only scheme-less relative paths are same-origin by construction.
  return !/^([a-zA-Z][a-zA-Z0-9+.-]*):/.test(trimmed);
}

const safeUrlTransform: UrlTransform = (value) => safeMarkdownUrl(value ?? "");

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

interface RichTextOptions {
  mentionByToken?: Map<string, MarkdownMentionUser>;
  resolveTaskKey?: (taskKey: string) => string | null | undefined;
}

function mentionTitle(person: MarkdownMentionUser) {
  const name = person.name?.trim();
  return name ? `${name} (${person.email})` : person.email;
}

/**
 * Splits `value` into plain-text segments and rich nodes: every `@mention`
 * token that maps to a known person and every task key that resolves to an
 * id becomes an escaped element node; everything else stays literal text.
 */
function richTextBoxSegments(
  value: string,
  mentionByToken: Map<string, MarkdownMentionUser> | undefined,
  resolveTaskKey: ((taskKey: string) => string | null | undefined) | undefined
): Array<string | HastNode> {
  const segments: Array<string | HastNode> = [];
  const pattern = new RegExp(`@([a-zA-Z0-9._-]+)|\\b[A-Z][A-Z0-9]{1,19}-\\d{1,10}\\b`, "g");
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(value)) !== null) {
    const [raw] = match;
    if (!raw) {
      break;
    }

    const start = match.index;
    const end = start + raw.length;
    if (start > cursor) {
      segments.push(value.slice(cursor, start));
    }

    const wrapped = wrapRichToken(raw, mentionByToken, resolveTaskKey);
    if (wrapped) {
      segments.push(wrapped);
    } else {
      segments.push(raw);
    }
    cursor = end;
  }

  if (cursor < value.length) {
    segments.push(value.slice(cursor));
  }
  return segments;
}

function wrapRichToken(
  raw: string,
  mentionByToken: Map<string, MarkdownMentionUser> | undefined,
  resolveTaskKey: ((taskKey: string) => string | null | undefined) | undefined
): HastNode | null {
  if (raw.startsWith("@")) {
    const person = mentionByToken?.get(raw.slice(1).toLowerCase());
    if (!person) {
      return null;
    }
    return {
      type: "element",
      tagName: "span",
      properties: {
        className: [
          "markdown-mention",
          "rounded-full px-1 font-medium",
          "bg-[var(--color-accent-muted)]",
          "text-[var(--color-accent)]",
        ],
        title: mentionTitle(person),
        "data-mention": person.id,
      },
      children: [{ type: "text", value: raw }],
    };
  }

  const taskId = resolveTaskKey?.(raw);
  if (!taskId) {
    return null;
  }
  return {
    type: "element",
    tagName: "a",
    properties: {
      className: ["markdown-task-link", "font-medium underline underline-offset-2", "text-[var(--color-accent)]"],
      href: `?task=${encodeURIComponent(taskId)}`,
    },
    children: [{ type: "text", value: raw }],
  };
}

/**
 * Walks a hast tree and augments text-containing elements in place: text
 * nodes are split and `@mention` tokens as well as resolvable task keys are
 * replaced by escaped React-safe element nodes. Code spans and fenced blocks
 * are skipped so their contents stay literal.
 */
function visitRichText(node: HastNode, options: RichTextOptions) {
  if (!node.children || (node.type === "element" && node.tagName === "code")) {
    return;
  }

  const nextChildren: HastNode[] = [];
  let changed = false;

  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string" && richTextBoxHasMatch(child.value, options)) {
      const segments = richTextBoxSegments(child.value, options.mentionByToken, options.resolveTaskKey);
      for (const segment of segments) {
        nextChildren.push(typeof segment === "string" ? { type: "text", value: segment } : segment);
      }
      changed = true;
      continue;
    }

    if (child.type === "element" || child.children?.length) {
      visitRichText(child, options);
    }
    nextChildren.push(child);
  }

  if (changed) {
    node.children = nextChildren;
  }
}

/**
 * Cheap pre-check so we skip regex work on the common "plain text only" case.
 */
function richTextBoxHasMatch(value: string, options: RichTextOptions) {
  if (options.resolveTaskKey && /\b[A-Z][A-Z0-9]{1,19}-\d{1,10}\b/.test(value)) {
    return true;
  }
  return options.mentionByToken !== undefined && /@([a-zA-Z0-9._-]+)/.test(value);
}

function createRichTextRehypePlugin(options: RichTextOptions) {
  // Standard unified plugin shape: an attacher that returns a transformer.
  return function rehypeRichTextPlugin() {
    return function richTextTransformer(tree: unknown) {
      visitRichText(tree as HastNode, options);
    };
  };
}

function createSharedComponents(allowImages: boolean): Components {
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    a: ({ node: _node, children, ...props }) => (
      <a
        {...props}
        href={safeMarkdownUrl(typeof props.href === "string" ? props.href : "") || undefined}
        target="_blank"
        rel="noopener noreferrer nofollow"
        className="underline underline-offset-2"
      >
        {children}
      </a>
    ),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    img: ({ node: _node, ...props }) => {
      if (!allowImages) {
        return null;
      }
      const src = typeof props.src === "string" ? props.src : "";
      if (!isSameOriginUrl(src)) {
        return null;
      }
      return (
        // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
        <img
          {...props}
          src={safeMarkdownUrl(src)}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      );
    },
    h1: ({ children }) => <h1 className="mb-3 mt-5 text-lg font-semibold">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-3 mt-5 text-base font-semibold">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-3 mt-5 text-base font-semibold">{children}</h3>,
    h4: ({ children }) => <h4 className="mb-2 mt-4 text-sm font-semibold">{children}</h4>,
    p: ({ children }) => <p className="my-3">{children}</p>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
    li: ({ children }) => <li className="leading-6">{children}</li>,
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    hr: () => <hr className="my-4 border-t" style={{ borderColor: "var(--color-border)" }} />,
    blockquote: ({ children }) => (
      <blockquote
        className="my-4 border-l-2 pl-4 italic"
        style={{ borderColor: "var(--color-border)", color: "var(--color-text-secondary)" }}
      >
        {children}
      </blockquote>
    ),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    code: ({ node: _node, className, children, ...props }) => {
      if (!className) {
        return (
          <code
            {...props}
            className="rounded px-1 py-0.5"
            style={{ backgroundColor: "var(--color-bg-muted)", color: "var(--color-text)" }}
          >
            {children}
          </code>
        );
      }

      return <code {...props} className={className}>{children}</code>;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pre: ({ node: _node, ...props }) => (
      <pre
        {...props}
        className="my-4 overflow-x-auto rounded-xl border p-3 text-xs leading-5"
        style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-surface)" }}
      />
    ),
    table: ({ children }) => (
      <div className="my-4 overflow-x-auto">
        <table
          className="w-full border-collapse text-left text-sm"
          style={{ borderColor: "var(--color-border)" }}
        >
          {children}
        </table>
      </div>
    ),
    th: ({ children }) => (
      <th
        className="border px-2 py-1 text-xs font-semibold"
        style={{ borderColor: "var(--color-border)", backgroundColor: "var(--color-bg-muted)" }}
      >
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="border px-2 py-1 align-top" style={{ borderColor: "var(--color-border)" }}>
        {children}
      </td>
    ),
  };
}

export function Markdown({
  source,
  className,
  mentionUsers,
  resolveTaskKey,
  allowImages = false,
  breaks = false,
}: MarkdownProps) {
  const components = useMemo(() => createSharedComponents(allowImages), [allowImages]);

  // Turn single newlines into markdown hard breaks (two trailing spaces) while
  // leaving blank lines (paragraph boundaries) untouched.
  const preparedSource = useMemo(
    () => (breaks ? source.replace(/(\r?\n)(?!\r?\n)/g, "  \n") : source),
    [breaks, source]
  );

  const rehypePlugins = useMemo(() => {
    const mentionByToken = new Map<string, MarkdownMentionUser>();
    for (const person of mentionUsers ?? []) {
      for (const token of mentionTokensFor(person)) {
        if (!mentionByToken.has(token)) {
          mentionByToken.set(token, person);
        }
      }
    }
    return [
      createRichTextRehypePlugin({
        mentionByToken: mentionByToken.size > 0 ? mentionByToken : undefined,
        resolveTaskKey,
      }),
    ];
  }, [mentionUsers, resolveTaskKey]);

  return (
    <div
      className={cn("markdown-body break-words text-sm leading-6", className)}
      style={{ color: "var(--color-text)" }}
      data-markdown="true"
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        skipHtml
        disallowedElements={["script", "style", "iframe", "object", "embed", "form", "button", "video", "audio"]}
        urlTransform={safeUrlTransform}
        components={components}
      >
        {preparedSource ?? ""}
      </ReactMarkdown>
    </div>
  );
}