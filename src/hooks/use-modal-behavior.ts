"use client";

import * as React from "react";

/**
 * Shared modal/window behaviour for Dialog and the task detail side panel:
 * focus trap, Escape-to-close, focus restore on close and a body scroll lock.
 *
 * The DOM-independent pieces (focusable selector + Tab wrap-around maths) are
 * exported for unit testing.
 */

/** Selector for elements that participate in the tab order inside a modal */
export const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * LIFO stack of currently open modals, so only the innermost modal owns
 * Escape/Tab when dialogs are nested (e.g. a confirm dialog inside the task
 * detail panel). Modal ids are opaque objects; use registerModal/unregisterModal.
 */
const modalStack: object[] = [];

export function registerModal(id: object) {
  modalStack.push(id);
}

export function unregisterModal(id: object) {
  const index = modalStack.lastIndexOf(id);
  if (index >= 0) {
    modalStack.splice(index, 1);
  }
}

/** True when the given (registered) modal id is the innermost open modal */
export function isTopmostModal(id: object): boolean {
  return modalStack.length > 0 && modalStack[modalStack.length - 1] === id;
}

/**
 * Compute the next trap index for a Tab press inside a modal.
 * Returns the index to focus, or -1 when there are no focusable elements
 * (the caller should focus the modal container itself).
 */
export function nextWrapIndex(
  currentIndex: number,
  length: number,
  shiftKey: boolean
): number {
  if (length <= 0) {
    return -1;
  }

  if (currentIndex < 0) {
    return shiftKey ? length - 1 : 0;
  }

  const nextIndex = shiftKey ? currentIndex - 1 : currentIndex + 1;
  if (nextIndex < 0) return length - 1;
  if (nextIndex >= length) return 0;
  return nextIndex;
}

/** List of focusable elements inside a modal container */
export function getModalFocusableElements(container: HTMLElement | null): HTMLElement[] {
  return Array.from(
    container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []
  ).filter(
    (element) =>
      !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true"
  );
}

export interface UseModalBehaviorOptions {
  open: boolean;
  onClose: () => void;
  /** Element to focus instead of the first focusable when the modal opens */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Modal window behaviour for a controlled panel:
 * - moves focus into the panel on open (initialFocusRef or first focusable, else the panel)
 * - traps Tab within the panel
 * - closes on Escape (only when this modal is the innermost open one)
 * - locks body scroll and restores the previous state on close/unmount
 * - restores focus to the previously focused element on close/unmount
 */
export function useModalBehavior(
  panelRef: React.RefObject<HTMLElement | null>,
  { open, onClose, initialFocusRef }: UseModalBehaviorOptions
) {
  const onCloseRef = React.useRef(onClose);

  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const panel = panelRef.current;
    const modalId = {};
    registerModal(modalId);
    const previouslyFocusedElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;

    function focusPanel() {
      panel?.focus();
    }

    function focusInitial() {
      const initialFocusElement = initialFocusRef?.current;
      if (initialFocusElement instanceof HTMLElement) {
        initialFocusElement.focus();
        return;
      }

      const firstFocusableElement = getModalFocusableElements(panel)[0];
      if (firstFocusableElement) {
        firstFocusableElement.focus();
      } else {
        focusPanel();
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      // Let a modal stacked on top of this one own Escape/Tab entirely.
      if (!isTopmostModal(modalId)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") {
        return;
      }

      const focusableElements = getModalFocusableElements(panel);
      if (focusableElements.length === 0) {
        event.preventDefault();
        focusPanel();
        return;
      }

      const currentIndex = focusableElements.indexOf(
        document.activeElement as HTMLElement
      );
      const nextIndex = nextWrapIndex(currentIndex, focusableElements.length, event.shiftKey);

      if (nextIndex === -1) {
        event.preventDefault();
        focusPanel();
        return;
      }

      event.preventDefault();
      focusableElements[nextIndex].focus();
    }

    const focusTimer = window.setTimeout(focusInitial, 0);

    document.addEventListener("keydown", handleKeyDown);
    document.body.style.overflow = "hidden";

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      unregisterModal(modalId);
      document.body.style.overflow = previousOverflow;
      previouslyFocusedElement?.focus();
    };
    // panelRef is a stable container ref and is intentionally not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialFocusRef]);
}