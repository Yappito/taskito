import * as React from "react";
import { cn } from "@/lib/utils";

export type AlertVariant = "danger" | "warning" | "success" | "info";

/** Token mapping for each alert variant (border + muted background + text token) */
export const alertTokens: Record<AlertVariant, { background: string; border: string; color: string }> = {
  danger: {
    background: "color-mix(in srgb, var(--color-danger) 10%, transparent)",
    border: "color-mix(in srgb, var(--color-danger) 35%, var(--color-border))",
    color: "var(--color-danger)",
  },
  warning: {
    background: "color-mix(in srgb, var(--color-warning) 12%, transparent)",
    border: "color-mix(in srgb, var(--color-warning) 35%, var(--color-border))",
    color: "var(--color-warning)",
  },
  success: {
    background: "color-mix(in srgb, var(--color-success) 10%, transparent)",
    border: "color-mix(in srgb, var(--color-success) 35%, var(--color-border))",
    color: "var(--color-success)",
  },
  info: {
    background: "color-mix(in srgb, var(--color-info) 10%, transparent)",
    border: "color-mix(in srgb, var(--color-info) 35%, var(--color-border))",
    color: "var(--color-info)",
  },
};

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  variant?: AlertVariant;
  /** Optional bold lead-in rendered before the message */
  title?: React.ReactNode;
}

/** Inline status banner (danger banners get role="alert", others announce politely) */
function Alert({ variant = "info", title, className, children, ...props }: AlertProps) {
  const tokens = alertTokens[variant];
  return (
    <div
      role={variant === "danger" ? "alert" : "status"}
      aria-live={variant === "danger" ? "assertive" : "polite"}
      className={cn("rounded-lg border px-3 py-2 text-sm", className)}
      style={{
        backgroundColor: tokens.background,
        borderColor: tokens.border,
        color: tokens.color,
      }}
      {...props}
    >
      {title != null && <span className="mr-1.5 font-semibold">{title}</span>}
      {children}
    </div>
  );
}

export { Alert };
