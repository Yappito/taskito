"use client";

import { useState, useEffect, useRef, useCallback, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";

type SearchPriority = "urgent" | "high" | "medium" | "low" | "none";

function HighlightedText({
  value,
  className,
  style,
}: {
  value: string;
  className?: string;
  style?: CSSProperties;
}) {
  const parts = value.split(/(<mark>.*?<\/mark>)/g).filter(Boolean);

  return (
    <span className={className} style={style}>
      {parts.map((part, index) => {
        const isHighlighted = part.startsWith("<mark>") && part.endsWith("</mark>");
        const text = isHighlighted ? part.slice(6, -7) : part;
        return isHighlighted ? <mark key={`${text}-${index}`}>{text}</mark> : <span key={`${text}-${index}`}>{text}</span>;
      })}
    </span>
  );
}

/** Global Cmd+K search modal with type-ahead and faceted filtering */
export function SearchModal() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPriorities, setSelectedPriorities] = useState<SearchPriority[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const pathname = usePathname();

  const currentProjectSlug = useCallback(() => {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const [firstSegment] = segments;
    if (["login", "api"].includes(firstSegment)) return null;
    return firstSegment;
  }, [pathname]);

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setSelectedPriorities([]);
    }
  }, [open]);

  const { data: results, isFetching } = trpc.search.query.useQuery(
    {
      query,
      priorities: selectedPriorities.length > 0 ? selectedPriorities : undefined,
      limit: 10,
    },
    {
      enabled: open && query.length > 0,
    }
  );

  const togglePriority = useCallback((p: SearchPriority) => {
    setSelectedPriorities((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }, []);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors"
        style={{
          backgroundColor: "var(--color-surface)",
          border: "1px solid var(--color-border)",
          color: "var(--color-text-muted)",
          boxShadow: "var(--shadow-sm)",
        }}
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <span>Search...</span>
        <kbd
          className="ml-2 rounded px-1.5 py-0.5 text-xs"
          style={{
            backgroundColor: "var(--color-bg-muted)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text-muted)",
          }}
        >
          ⌘K
        </kbd>
      </button>
    );
  }

  return (
    <>
      {/* Backdrop — rendered via portal to escape header stacking context */}
      {createPortal(
        <>
          <div
            className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />

          {/* Modal */}
          <div className="fixed left-1/2 top-[15%] z-50 w-full max-w-xl -translate-x-1/2">
        <div
          className="rounded-xl"
          style={{
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {/* Search input */}
          <div
            className="flex items-center px-4"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <svg
              className="h-5 w-5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              style={{ color: "var(--color-text-muted)" }}
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tasks..."
              className="flex-1 border-0 bg-transparent px-3 py-4 text-sm focus:outline-none"
              style={{ color: "var(--color-text)" }}
            />
            {isFetching && (
              <div
                className="h-4 w-4 animate-spin rounded-full border-2 border-t-transparent"
                style={{ borderColor: "var(--color-accent)", borderTopColor: "transparent" }}
              />
            )}
          </div>

          {/* Priority filters */}
          <div
            className="flex gap-1 px-4 py-2"
            style={{ borderBottom: "1px solid var(--color-border)" }}
          >
            <span className="mr-1 self-center text-xs" style={{ color: "var(--color-text-muted)" }}>
              Priority:
            </span>
            {(["urgent", "high", "medium", "low", "none"] as const).map((p) => (
              <button
                key={p}
                onClick={() => togglePriority(p)}
                className="rounded px-2 py-0.5 text-xs capitalize transition-colors"
                style={
                  selectedPriorities.includes(p)
                    ? {
                        backgroundColor: "var(--color-accent-muted)",
                        color: "var(--color-accent)",
                      }
                    : { color: "var(--color-text-muted)" }
                }
              >
                {p}
              </button>
            ))}
          </div>

          {/* Results */}
          <div className="max-h-80 overflow-y-auto">
            {results?.hits && results.hits.length > 0 ? (
              <ul>
                {results.hits.map((hit) => (
                  <li key={hit.id}>
                    <button
                      onClick={() => {
                        setOpen(false);
                        const slug = (hit as { projectSlug?: string }).projectSlug;
                        const fallbackSlug = currentProjectSlug();
                        const targetSlug = slug || fallbackSlug;
                        if (targetSlug) {
                          router.push(`/${targetSlug}?task=${hit.id}`);
                        }
                      }}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors"
                      style={{ color: "var(--color-text)" }}
                      onMouseEnter={(e) =>
                        (e.currentTarget.style.backgroundColor = "var(--color-surface-hover)")
                      }
                      onMouseLeave={(e) =>
                        (e.currentTarget.style.backgroundColor = "transparent")
                      }
                    >
                      <div className="min-w-0 flex-1">
                        {(hit as { projectKey?: string; taskNumber?: number }).projectKey && (
                          <span
                            className="text-[10px] font-bold"
                            style={{ color: "var(--color-text-muted)" }}
                          >
                            {(hit as { projectKey?: string }).projectKey}-{(hit as { taskNumber?: number }).taskNumber}{" "}
                          </span>
                        )}
                        <HighlightedText
                          value={hit._formatted?.title ?? hit.title}
                          className="truncate text-sm font-medium"
                        />
                        {hit._formatted?.description && (
                          <HighlightedText
                            value={hit._formatted.description}
                            className="mt-0.5 truncate text-xs"
                            style={{ color: "var(--color-text-secondary)" }}
                          />
                        )}
                        <div className="mt-1 flex gap-1">
                          {hit.tags.map((tag) => (
                            <span
                              key={tag}
                              className="rounded px-1.5 py-0.5 text-xs"
                              style={{
                                backgroundColor: "var(--color-bg-muted)",
                                color: "var(--color-text-secondary)",
                              }}
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span
                        className="mt-0.5 rounded px-1.5 py-0.5 text-xs capitalize"
                        style={{
                          backgroundColor: "var(--color-bg-muted)",
                          color: "var(--color-text-muted)",
                        }}
                      >
                        {hit.priority}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : query.length > 0 && !isFetching ? (
              <div className="py-8 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
                No results found
              </div>
            ) : (
              <div className="py-8 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
                Type to search tasks...
              </div>
            )}
          </div>

          {/* Footer */}
          {results && (
            <div
              className="px-4 py-2 text-xs"
              style={{
                borderTop: "1px solid var(--color-border)",
                color: "var(--color-text-muted)",
              }}
            >
              {results.totalHits} results in {results.processingTimeMs}ms
              {results.facetDistribution?.priority && (
                <span className="ml-3">
                  {Object.entries(results.facetDistribution.priority)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(" · ")}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body
  )}
  </>
  );
}
