"use client";

import { cn } from "@/lib/utils";

/**
 * Displays a CSS-animated pulse effect in the Monitor area while a test is RUNNING,
 * simulating an active stream when the cloud backend is not connected.
 */
export function RunningPulsePlaceholder({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "absolute inset-0 flex items-center justify-center rounded-md bg-muted/30 animate-stream-pulse",
        className
      )}
      aria-hidden
    >
      <div className="rounded-lg border border-border/50 bg-background/20 px-4 py-2 text-sm text-muted-foreground">
        Simulating stream…
      </div>
    </div>
  );
}
