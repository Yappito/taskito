"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useModalBehavior } from "@/hooks/use-modal-behavior";

/** Dialog/modal overlay */
function DialogOverlay({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 bg-[var(--color-overlay)] backdrop-blur-sm",
        className
      )}
      {...props}
    />
  );
}

/** Dialog/modal container */
function Dialog({
  open,
  onClose,
  children,
  panelClassName,
  title,
  description,
}: {
  open: boolean;
  onClose: () => void;
  /** Optional: a dialog may consist of only its title/description */
  children?: React.ReactNode;
  panelClassName?: string;
  /** Optional heading rendered inside the panel and linked via aria-labelledby */
  title?: React.ReactNode;
  /** Optional description rendered under the title and linked via aria-describedby */
  description?: React.ReactNode;
}) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const headingId = React.useId();
  const descriptionId = React.useId();

  // Shared modal behaviour: focus trap, Escape, focus restore, scroll lock.
  useModalBehavior(panelRef, { open, onClose });

  if (!open) return null;

  return (
    <>
      <DialogOverlay />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={onClose}>
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={title != null ? headingId : undefined}
          aria-describedby={description != null ? descriptionId : undefined}
          tabIndex={-1}
          className={cn("relative max-h-[calc(100vh-2rem)] w-full max-w-lg overflow-y-auto rounded-lg p-6 shadow-xl", panelClassName)}
          style={{
            backgroundColor: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            color: "var(--color-text)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {(title != null || description != null) && (
            <div className="mb-4">
              {title != null && (
                <h2
                  id={headingId}
                  className="text-lg font-semibold"
                  style={{ color: "var(--color-text)" }}
                >
                  {title}
                </h2>
              )}
              {description != null && (
                <p
                  id={descriptionId}
                  className="mt-1 text-sm"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  {description}
                </p>
              )}
            </div>
          )}
          {children}
        </div>
      </div>
    </>
  );
}

export { Dialog };

/** Wrapper that provides the open/onOpenChange API used by shadcn-style consumers */
function DialogControlled({
  open,
  onOpenChange,
  children,
  panelClassName,
  title,
  description,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children?: React.ReactNode;
  panelClassName?: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={() => onOpenChange(false)}
      panelClassName={panelClassName}
      title={title}
      description={description}
    >
      {children}
    </Dialog>
  );
}

/** Dialog content wrapper (pass-through since Dialog already provides the container) */
function DialogContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={className}>{children}</div>;
}

/** Dialog header section */
function DialogHeader({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <div className={cn("mb-4", className)}>{children}</div>;
}

/** Dialog title */
function DialogTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={cn("text-lg font-semibold", className)}
      style={{ color: "var(--color-text)" }}
    >
      {children}
    </h2>
  );
}

export { DialogControlled, DialogContent, DialogHeader, DialogTitle };
