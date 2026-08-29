import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it, expect } from "vitest";
import {
  confirmReducer,
  ConfirmDialog,
  initialConfirmState,
  type ConfirmState,
  type ConfirmOptions,
} from "../confirm-dialog";

const options: ConfirmOptions = {
  title: "Delete task?",
  description: "This moves the task to the archive.",
  confirmLabel: "Delete",
  destructive: true,
};

describe("confirm state machine (useConfirm hook state)", () => {
  it("starts closed with no pending options", () => {
    expect(initialConfirmState).toEqual({ open: false, options: null });
    expect(confirmReducer(initialConfirmState, { type: "settle" })).toEqual(initialConfirmState);
  });

  it("opens with the pending options on ask", () => {
    const state = confirmReducer(initialConfirmState, { type: "ask", options });
    expect(state).toEqual({ open: true, options });
    expect(state.options?.confirmLabel).toBe("Delete");
    expect(state.options?.destructive).toBe(true);
  });

  it("resets to the initial state on settle", () => {
    const open = confirmReducer(initialConfirmState, { type: "ask", options });
    expect(confirmReducer(open, { type: "settle" })).toEqual(initialConfirmState);
  });

  it("ignores unknown actions", () => {
    const open: ConfirmState = confirmReducer(initialConfirmState, { type: "ask", options });
    expect(
      confirmReducer(open, { type: "mystery" } as unknown as { type: "ask"; options: ConfirmOptions })
    ).toEqual(open);
  });
});

describe("ConfirmDialog", () => {
  it("renders nothing while closed", () => {
    const markup = renderToStaticMarkup(
      createElement(ConfirmDialog, { ...options, open: false, onClose: () => {} })
    );
    expect(markup).toBe("");
  });

  it("renders an accessible dialog with the confirm/cancel actions", () => {
    const markup = renderToStaticMarkup(
      createElement(ConfirmDialog, { ...options, open: true, onClose: () => {} })
    );
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain("aria-modal=\"true\"");
    expect(markup).toContain("aria-labelledby");
    expect(markup).toContain("Delete task?");
    expect(markup).toContain("This moves the task to the archive.");
    expect(markup).toContain("Delete");
    expect(markup).toContain("Cancel");
  });

  it("uses the default labels and non-destructive variant when not flagged", () => {
    const markup = renderToStaticMarkup(
      createElement(ConfirmDialog, {
        open: true,
        title: "Reassign?",
        onClose: () => {},
        onConfirm: () => {},
      })
    );
    expect(markup).toContain("Confirm");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain("bg-[var(--color-danger)]");
  });
});
