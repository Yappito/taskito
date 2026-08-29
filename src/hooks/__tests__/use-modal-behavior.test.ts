import { describe, it, expect } from "vitest";
import {
  FOCUSABLE_SELECTOR,
  registerModal,
  unregisterModal,
  isTopmostModal,
  nextWrapIndex,
} from "../use-modal-behavior";

describe("nextWrapIndex", () => {
  it("returns -1 for an empty trap", () => {
    expect(nextWrapIndex(0, 0, false)).toBe(-1);
    expect(nextWrapIndex(0, 0, true)).toBe(-1);
  });

  it("moves forward with Tab", () => {
    expect(nextWrapIndex(0, 3, false)).toBe(1);
    expect(nextWrapIndex(1, 3, false)).toBe(2);
  });

  it("wraps forward from the last element to the first", () => {
    expect(nextWrapIndex(2, 3, false)).toBe(0);
    expect(nextWrapIndex(5, 6, false)).toBe(0);
  });

  it("moves backward with Shift+Tab", () => {
    expect(nextWrapIndex(2, 3, true)).toBe(1);
    expect(nextWrapIndex(1, 3, true)).toBe(0);
  });

  it("wraps backward from the first element to the last", () => {
    expect(nextWrapIndex(0, 3, true)).toBe(2);
  });

  it("starts at the first element when nothing is focused yet", () => {
    expect(nextWrapIndex(-1, 3, false)).toBe(0);
  });

  it("starts at the last element when nothing is focused and Shift is held", () => {
    expect(nextWrapIndex(-1, 3, true)).toBe(2);
  });

  it("handles a single focusable element", () => {
    expect(nextWrapIndex(0, 1, false)).toBe(0);
    expect(nextWrapIndex(0, 1, true)).toBe(0);
  });
});

describe("modal stack", () => {
  it("is empty by default", () => {
    expect(isTopmostModal({})).toBe(false);
  });

  it("marks only the last registered modal as topmost", () => {
    const outer = {};
    const inner = {};
    try {
      registerModal(outer);
      expect(isTopmostModal(outer)).toBe(true);
      registerModal(inner);
      expect(isTopmostModal(outer)).toBe(false);
      expect(isTopmostModal(inner)).toBe(true);
      unregisterModal(inner);
      expect(isTopmostModal(outer)).toBe(true);
      unregisterModal(outer);
      expect(isTopmostModal(outer)).toBe(false);
    } finally {
      unregisterModal(outer);
      unregisterModal(inner);
    }
  });

  it("ignores unregistering unknown ids", () => {
    const modal = {};
    try {
      registerModal(modal);
      unregisterModal({});
      expect(isTopmostModal(modal)).toBe(true);
    } finally {
      unregisterModal(modal);
    }
    unregisterModal(modal); // double unregister is harmless
    expect(isTopmostModal(modal)).toBe(false);
  });
});

describe("selector exports", () => {
  it("focusable selector covers interactive elements and positive tab indices", () => {
    const selector = FOCUSABLE_SELECTOR;
    for (const token of ["a[href]", "button:not([disabled])", "textarea:not([disabled])", "input:not([disabled])", "select:not([disabled])", '[tabindex]:not([tabindex="-1"])']) {
      expect(selector).toContain(token);
    }
  });
});