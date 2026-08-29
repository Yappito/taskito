"use client";

import {
  forwardRef,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  filterMentionCandidates,
  findActiveMention,
  insertMention,
  mentionLabelFor,
  mentionTokenFor,
  type MentionPerson,
} from "@/lib/mentions";

/**
 * Textarea with an `@mention` autocomplete popover.
 *
 * Triggered when the caret sits right after an `@` query (see
 * `findActiveMention`). Candidates come from the project people list and are
 * filtered by name/email. Keyboard: ArrowUp/ArrowDown move the highlight,
 * Enter/Tab select, Escape dismisses until the query changes. Selecting a
 * person inserts exactly the token format that the server-side
 * `resolveMentionedUserIds` expects (see src/lib/mentions.ts).
 *
 * Accessibility: the textarea acts as a combobox controlling a listbox with
 * aria-activedescendant tracking the highlighted option.
 */

export interface MentionTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "onSelect"> {
  value: string;
  onChange: (value: string) => void;
  people: readonly MentionPerson[];
  maxSuggestions?: number;
}

export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(
  function MentionTextarea(
    {
      value,
      onChange,
      people,
      maxSuggestions = 8,
      className,
      onKeyDown,
      onBlur,
      ...props
    },
    forwardedRef
  ) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const [caret, setCaret] = useState<number | null>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [dismissedKey, setDismissedKey] = useState<string | null>(null);
    const pendingCaretRef = useRef<number | null>(null);
    const listboxId = useId();

    function setCaretFromElement(element: HTMLTextAreaElement | null) {
      if (!element) {
        return;
      }
      setCaret(element.selectionStart ?? null);
    }

    const activeMention = useMemo(
      () => (caret === null ? null : findActiveMention(value, caret)),
      [caret, value]
    );

    const candidates = useMemo(() => {
      if (!activeMention) {
        return [];
      }
      return filterMentionCandidates(people, activeMention.query).slice(0, maxSuggestions);
    }, [activeMention, maxSuggestions, people]);

    // A stable identifier for the currently active mention query. Escape
    // dismissals are keyed against it, so the popover stays closed until the
    // query actually changes (typing more characters or moving the caret).
    const activeMentionKey = activeMention
      ? `${activeMention.start}:${activeMention.end}:${activeMention.query}`
      : "closed";

    const open =
      activeMention !== null && candidates.length > 0 && dismissedKey !== activeMentionKey;

    useEffect(() => {
      if (highlightedIndex >= candidates.length) {
        setHighlightedIndex(0);
      }
    }, [candidates.length, highlightedIndex]);

    function setRefs(element: HTMLTextAreaElement | null) {
      textareaRef.current = element;
      if (typeof forwardedRef === "function") {
        forwardedRef(element);
      } else if (forwardedRef) {
        forwardedRef.current = element;
      }
    }

    // Restore the caret after an insertion, so typing can continue seamlessly.
    useEffect(() => {
      if (pendingCaretRef.current === null) {
        return;
      }
      const element = textareaRef.current;
      const nextCaret = pendingCaretRef.current;
      pendingCaretRef.current = null;
      if (element && document.contains(element)) {
        element.focus();
        element.setSelectionRange(nextCaret, nextCaret);
      }
      setCaret(nextCaret);
    }, [value]);

    function selectCandidate(person: MentionPerson) {
      const at = caret ?? value.length;
      const result = insertMention(value, at, person);
      pendingCaretRef.current = result.caret;
      onChange(result.text);
      setDismissedKey(null);
    }

    function dismiss() {
      setDismissedKey(activeMentionKey);
    }

    function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
      if (open) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setHighlightedIndex((current) => (current + 1) % candidates.length);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setHighlightedIndex(
            (current) => (current - 1 + candidates.length) % candidates.length
          );
          return;
        }
        if (event.key === "Enter" && !event.nativeEvent.isComposing && !event.shiftKey) {
          event.preventDefault();
          selectCandidate(candidates[highlightedIndex]!);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          selectCandidate(candidates[highlightedIndex]!);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
          return;
        }
      }
      onKeyDown?.(event);
    }

    function handleBlur(event: ReactFocusEvent<HTMLTextAreaElement>) {
      // Give click handlers on the popover a chance to run before closing.
      window.setTimeout(() => {
        if (document.activeElement !== textareaRef.current) {
          setCaret(null);
        }
      }, 120);
      onBlur?.(event);
    }

    return (
      <div className="relative">
        <Textarea
          {...props}
          ref={setRefs}
          value={value}
          className={cn(className)}
          onChange={(event) => {
            pendingCaretRef.current = null;
            const element = event.currentTarget;
            onChange(element.value);
            setCaret(element.selectionStart ?? null);
          }}
          onKeyUp={(event) => setCaretFromElement(event.currentTarget)}
          onClick={(event) => setCaretFromElement(event.currentTarget)}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-controls={open ? listboxId : undefined}
          aria-activedescendant={
            open && candidates[highlightedIndex]
              ? mentionOptionId(listboxId, candidates[highlightedIndex]!)
              : undefined
          }
        />
        {open && (
          <ul
            id={listboxId}
            key={activeMentionKey}
            role="listbox"
            aria-label="Mention people"
            className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-lg border shadow-lg"
            style={{
              backgroundColor: "var(--color-surface)",
              borderColor: "var(--color-border)",
              color: "var(--color-text)",
            }}
          >
            {candidates.map((person, index) => {
              const optionId = mentionOptionId(listboxId, person);
              const selected = index === highlightedIndex;
              return (
                <li
                  key={person.id}
                  id={optionId}
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    "cursor-pointer px-3 py-2 text-sm",
                    index === 0 && "first:rounded-t-lg",
                    index === candidates.length - 1 && "last:rounded-b-lg"
                  )}
                  style={{
                    backgroundColor: selected ? "var(--color-bg-muted)" : "transparent",
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => selectCandidate(person)}
                >
                  <span className="font-medium">{mentionLabelFor(person)}</span>
                  <span className="ml-2 text-xs" style={{ color: "var(--color-text-muted)" }}>
                    {mentionTokenFor(person)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }
);

function mentionOptionId(listboxId: string, person: MentionPerson) {
  return `${listboxId}-option-${person.id}`;
}