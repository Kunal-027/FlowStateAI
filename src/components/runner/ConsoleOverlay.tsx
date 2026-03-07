"use client";

import { useRef, useEffect, useState } from "react";
import { useExecutionStore } from "@/store/useExecutionStore";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { LogEntry } from "@/types/execution";
import { ChevronDown, ChevronUp } from "lucide-react";

const levelStyles: Record<LogEntry["level"], string> = {
  info: "text-muted-foreground",
  warn: "text-amber-400",
  error: "text-destructive",
  healing: "text-amber-400",
  retry: "text-blue-400",
};

/**
 * Interactive log window subscribed to the Zustand store (logs). Automatically updates
 * when the mock execution service or any code pushes a new log via addLog.
 * Sits beside the Monitor (side-by-side layout); fills remaining width and height.
 */
export function ConsoleOverlay({ className }: { className?: string }) {
  const logs = useExecutionStore((s) => s.logs);
  const [expanded, setExpanded] = useState(true);
  const scrollContentRef = useRef<HTMLDivElement>(null);

  /** Scrolls the console viewport to the bottom when new logs are added or when the panel is expanded. */
  useEffect(() => {
    if (!expanded) return;
    const el = scrollContentRef.current?.parentElement;
    if (el && el.scrollHeight > el.clientHeight) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs.length, expanded]);

  return (
    <section
      className={cn(
        "flex flex-col rounded-lg border border-border bg-card/95 backdrop-blur w-[320px] min-w-[280px] shrink-0 min-h-0 overflow-hidden",
        className
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex h-10 shrink-0 items-center justify-between px-3 text-left hover:bg-muted/50 transition-colors"
      >
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Console
        </h2>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <ScrollArea
          className="flex-1 min-h-0 w-full font-mono text-xs"
        >
          <div ref={scrollContentRef} className="space-y-0.5 pr-3 pl-3 pb-2">
            {logs.length === 0 ? (
              <p className="text-muted-foreground/70 py-2">No logs yet. Run a test to see output.</p>
            ) : (
              logs.map((entry) => (
                <div
                  key={entry.id}
                  className={cn("flex gap-2 break-all py-0.5", levelStyles[entry.level])}
                >
                  <span className="shrink-0 text-muted-foreground/60">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                  <span className={cn("shrink-0", entry.level === "healing" && "font-medium")}>
                    [{entry.level}]
                  </span>
                  <span>{entry.message}</span>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}
