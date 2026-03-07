import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** CVA definition for status badge variants: queued, running, success, failed, healing, retrying. */
const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
  {
    variants: {
      variant: {
        default: "border-transparent bg-muted text-muted-foreground",
        queued: "border-transparent bg-muted text-muted-foreground",
        running: "border-transparent bg-accent/20 text-accent animate-pulse-subtle",
        success: "border-transparent bg-emerald-500/15 text-emerald-400",
        failed: "border-transparent bg-destructive/15 text-destructive",
        healing: "border-transparent bg-amber-500/15 text-amber-400 animate-healing-glow",
        retrying: "border-transparent bg-blue-500/15 text-blue-400 animate-retry-pulse",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

/** Renders a small status badge with the given variant (used for test case and step status). */
function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
