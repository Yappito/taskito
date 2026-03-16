"use client";

import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { StatusBadge } from "@/components/task/status-badge";

type SearchPriority = "urgent" | "high" | "medium" | "low" | "none";
const LAST_PROJECT_SLUG_KEY = "taskito-last-project-slug";

interface SearchTaskHit {
  id: string;
  title: string;
  priority: SearchPriority;
  dueDate: string;
  tags: Array<{
    id: string;
    name: string;
    color: string;
  }>;
  status: {
    id: string;
    name: string;
    color: string;
  };
  assignee: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  projectSlug?: string;
  projectKey?: string;
  taskNumber?: number;
  _formatted?: Record<string, string>;
}

function formatDueDate(value: string) {
  return new Date(value).toLocaleDateString();
}

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
  const [selectedResultIndex, setSelectedResultIndex] = useState(-1);
  const [activeProjectSlug, setActiveProjectSlug] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const previousPathnameRef = useRef(pathname);

  const currentProjectSlug = useCallback(() => {
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length === 0) return null;
    const [firstSegment] = segments;
    if (["login", "api"].includes(firstSegment)) return null;
    return firstSegment;
  }, [pathname]);

  const closeModal = useCallback(() => {
    setOpen(false);
  }, []);

  const openModal = useCallback(() => {
    setOpen(true);
  }, []);

  // Focus input when modal opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery("");
      setSelectedPriorities([]);
      setSelectedResultIndex(-1);
    }
  }, [open]);

  useEffect(() => {
    if (previousPathnameRef.current !== pathname && open) {
      closeModal();
    }
    previousPathnameRef.current = pathname;
  }, [closeModal, open, pathname]);

  useEffect(() => {
    const slug = currentProjectSlug();
    if (slug && slug !== "settings") {
      window.localStorage.setItem(LAST_PROJECT_SLUG_KEY, slug);
      setActiveProjectSlug(slug);
      return;
    }

    setActiveProjectSlug(window.localStorage.getItem(LAST_PROJECT_SLUG_KEY));
  }, [currentProjectSlug]);

  const { data: activeProject } = trpc.project.bySlug.useQuery(
    { slug: activeProjectSlug ?? "" },
    { enabled: !!activeProjectSlug }
  );

  const { data: results, isFetching } = trpc.search.query.useQuery(
    {
      query,
      projectId: activeProject?.id ?? "",
      priorities: selectedPriorities.length > 0 ? selectedPriorities : undefined,
      limit: 10,
    },
    {
      enabled: open && query.length > 0 && !!activeProject?.id,
    }
  );

  const resultsList = useMemo(() => (results?.hits ?? []) as SearchTaskHit[], [results]);

  const openHit = useCallback((hit: SearchTaskHit) => {
    closeModal();
    const targetSlug = hit.projectSlug || activeProjectSlug;
    if (targetSlug) {
      router.push(`/${targetSlug}?task=${hit.id}`);
    }
  }, [activeProjectSlug, closeModal, router]);

  // Keyboard shortcut: Cmd+K / Ctrl+K
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
        return;
      }

      if (!open) {
        return;
      }

      if (e.key === "Escape") {
        e.preventDefault();
        closeModal();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (resultsList.length === 0) return;
        setSelectedResultIndex((prev) => (prev + 1) % resultsList.length);
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (resultsList.length === 0) return;
        setSelectedResultIndex((prev) => (prev <= 0 ? resultsList.length - 1 : prev - 1));
        return;
      }

      if (e.key === "Enter" && selectedResultIndex >= 0 && resultsList[selectedResultIndex]) {
        e.preventDefault();
        openHit(resultsList[selectedResultIndex]);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [closeModal, open, openHit, resultsList, selectedResultIndex]);

  const togglePriority = useCallback((p: SearchPriority) => {
    setSelectedPriorities((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }

    if (resultsList.length === 0) {
      setSelectedResultIndex(-1);
      return;
    }

    setSelectedResultIndex((prev) => {
      if (prev < 0 || prev >= resultsList.length) {
        return 0;
      }
      return prev;
    });
  }, [open, resultsList]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={openModal}
        className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-colors"
        aria-haspopup="dialog"
        aria-expanded="false"
        aria-label="Open search"
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
            onMouseDown={closeModal}
          />

          {/* Modal */}
          <div
            className="fixed left-1/2 top-[15%] z-50 w-full max-w-xl -translate-x-1/2"
            role="dialog"
            aria-modal="true"
            aria-label="Search tasks"
            aria-describedby="search-modal-results"
            onMouseDown={(event) => event.stopPropagation()}
          >
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
              role="combobox"
              aria-expanded="true"
              aria-controls="search-modal-results"
              aria-activedescendant={selectedResultIndex >= 0 ? `search-result-${resultsList[selectedResultIndex]?.id}` : undefined}
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
            className="flex items-center gap-1 px-4 py-2"
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
            {selectedPriorities.length > 0 && (
              <button
                type="button"
                onClick={() => setSelectedPriorities([])}
                className="ml-auto rounded px-2 py-0.5 text-xs transition-colors"
                style={{
                  backgroundColor: "var(--color-bg-muted)",
                  color: "var(--color-text-secondary)",
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Results */}
          <div id="search-modal-results" className="max-h-80 overflow-y-auto" role="listbox">
            {resultsList.length > 0 ? (
              <ul>
                {resultsList.map((hit, index) => {
                  const isSelected = index === selectedResultIndex;

                  return (
                  <li key={hit.id}>
                    <button
                      id={`search-result-${hit.id}`}
                      type="button"
                      onClick={() => openHit(hit)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors"
                      role="option"
                      aria-selected={isSelected}
                      style={{
                        color: "var(--color-text)",
                        backgroundColor: isSelected ? "var(--color-surface-hover)" : "transparent",
                      }}
                      onMouseEnter={() => setSelectedResultIndex(index)}
                      onFocus={() => setSelectedResultIndex(index)}
                    >
                      <div className="min-w-0 flex-1">
                        {(hit.projectKey || hit.projectSlug) && (
                          <div className="mb-0.5 flex items-center gap-1 text-[10px] font-bold" style={{ color: "var(--color-text-muted)" }}>
                            {hit.projectKey && <span>{hit.projectKey}-{hit.taskNumber}</span>}
                            {hit.projectSlug && <span>/{hit.projectSlug}</span>}
                          </div>
                        )}
                        <HighlightedText
                          value={hit._formatted?.title ?? hit.title}
                          className="truncate text-sm font-medium"
                        />
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                          <StatusBadge name={hit.status.name} color={hit.status.color} className="shrink-0" />
                          <span style={{ color: "var(--color-text-secondary)" }}>
                            Due {formatDueDate(hit.dueDate)}
                          </span>
                          <span style={{ color: "var(--color-text-secondary)" }}>
                            {hit.assignee?.name?.trim() || hit.assignee?.email || "Unassigned"}
                          </span>
                        </div>
                        {hit._formatted?.description && (
                          <HighlightedText
                            value={hit._formatted.description}
                            className="mt-0.5 line-clamp-2 text-xs"
                            style={{ color: "var(--color-text-secondary)" }}
                          />
                        )}
                        <div className="mt-1 flex flex-wrap gap-1">
                          {hit.tags.map((tag) => (
                            <span
                              key={tag.id}
                              className="rounded px-1.5 py-0.5 text-xs"
                              style={{
                                backgroundColor: `${tag.color}20`,
                                color: tag.color,
                              }}
                            >
                              {tag.name}
                            </span>
                          ))}
                        </div>
                      </div>
                      <span
                        className="mt-0.5 rounded px-1.5 py-0.5 text-xs capitalize"
                        style={{
                          backgroundColor: isSelected ? "var(--color-accent-muted)" : "var(--color-bg-muted)",
                          color: isSelected ? "var(--color-accent)" : "var(--color-text-muted)",
                        }}
                      >
                        {hit.priority}
                      </span>
                    </button>
                  </li>
                );})}
              </ul>
            ) : query.length > 0 && !activeProject?.id ? (
              <div className="py-8 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
                Open a project first to search its tasks
              </div>
            ) : query.length > 0 && isFetching ? (
              <div className="py-8 text-center text-sm" style={{ color: "var(--color-text-muted)" }}>
                Searching...
              </div>
            ) : query.length > 0 ? (
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
