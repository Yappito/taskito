"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Dialog } from "./dialog";
import { Button } from "./button";

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Renders the confirm action in the destructive variant */
  destructive?: boolean;
}

export interface ConfirmState {
  open: boolean;
  options: ConfirmOptions | null;
}

export type ConfirmAction =
  | { type: "ask"; options: ConfirmOptions }
  | { type: "settle" };

export const initialConfirmState: ConfirmState = { open: false, options: null };

/** Pure state machine behind the confirm dialog (kept free of DOM/React so it is trivially testable) */
export function confirmReducer(state: ConfirmState, action: ConfirmAction): ConfirmState {
  switch (action.type) {
    case "ask":
      return { open: true, options: action.options };
    case "settle":
      return initialConfirmState;
    default:
      return state;
  }
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onClose: () => void;
  onConfirm?: () => void;
  className?: string;
}

/** Confirmation dialog built on Dialog; use alongside useConfirm or standalone */
function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  className,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      panelClassName={cn("max-w-md", className)}
    >
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onClose}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant={destructive ? "destructive" : "default"}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export interface UseConfirmResult {
  /** Promise-based window.confirm replacement: resolve(true) on confirm, false on cancel */
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  /** Render this alongside your tree to host the dialog */
  confirmElement: React.ReactNode;
  isOpen: boolean;
}

/** Hook letting callers replace window.confirm with an in-app promise-based dialog */
export function useConfirm(): UseConfirmResult {
  const [state, dispatch] = React.useReducer(confirmReducer, initialConfirmState);
  const resolveRef = React.useRef<((confirmed: boolean) => void) | null>(null);

  const confirm = React.useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current?.(false);
      resolveRef.current = resolve;
      dispatch({ type: "ask", options });
    });
  }, []);

  const settle = React.useCallback((confirmed: boolean) => {
    resolveRef.current?.(confirmed);
    resolveRef.current = null;
    dispatch({ type: "settle" });
  }, []);

  const confirmElement =
    state.open && state.options ? (
      <ConfirmDialog
        open
        onClose={() => settle(false)}
        onConfirm={() => settle(true)}
        {...state.options}
      />
    ) : null;

  return { confirm, confirmElement, isOpen: state.open };
}

export { ConfirmDialog };
