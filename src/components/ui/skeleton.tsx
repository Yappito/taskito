import * as React from "react";
import { cn } from "@/lib/utils";

export type SkeletonProps = React.HTMLAttributes<HTMLDivElement>;

/** Single loading placeholder block */
const Skeleton = React.forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, ...props }, ref) => {
    return (
      <div
        ref={ref}
        aria-hidden="true"
        className={cn("animate-pulse rounded-md", className)}
        style={{ backgroundColor: "var(--color-bg-muted)" }}
        {...props}
      />
    );
  }
);
Skeleton.displayName = "Skeleton";

export interface SkeletonGroupProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/** Container that marks a loading region as busy for assistive tech */
function SkeletonGroup({ className, children, ...props }: SkeletonGroupProps) {
  return (
    <div
      aria-busy="true"
      aria-live="polite"
      className={cn("space-y-2", className)}
      {...props}
    >
      {children}
    </div>
  );
}

export { Skeleton, SkeletonGroup };
