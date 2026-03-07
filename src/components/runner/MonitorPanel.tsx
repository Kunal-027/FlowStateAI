"use client";

import { BrowserCanvas } from "@/components/streaming/BrowserCanvas";
import { useExecutionStore } from "@/store/useExecutionStore";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

const BROWSER_LABELS: Record<string, string> = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
};

/**
 * Monitor area: title, connection indicator, browser badge, and BrowserCanvas.
 * BrowserCanvas is state-aware (connects WebSocket when RUNNING, disconnects when IDLE)
 * and shows "Waiting for browser connection..." when disconnected.
 */
export function MonitorPanel({ className }: { className?: string }) {
  const streamSessionId = useExecutionStore((s) => s.streamSessionId);
  const streamConnected = useExecutionStore((s) => s.streamConnected);
  const activeTestCaseId = useExecutionStore((s) => s.activeTestCaseId);
  const testCases = useExecutionStore((s) => s.testCases);
  const selectedBrowser = useExecutionStore((s) => s.selectedBrowser);

  const activeCase = activeTestCaseId
    ? testCases.find((tc) => tc.id === activeTestCaseId)
    : null;
  const isRunning = activeCase?.status === "running";
  const hasStream = !!streamSessionId && streamConnected;
  const browserLabel = BROWSER_LABELS[selectedBrowser] ?? selectedBrowser;

  return (
    <section
      className={cn(
        "flex flex-col rounded-lg border border-border bg-card p-3 flex-1 min-h-0 min-w-0 overflow-hidden basis-0",
        className
      )}
    >
      <div className="mb-2 flex items-center justify-between shrink-0 gap-2">
        <h2 className="text-sm font-medium text-foreground shrink-0">Monitor</h2>
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="shrink-0 text-xs text-muted-foreground border border-border rounded px-2 py-0.5 font-medium"
            title="Test runs in this browser. Change it in the Browser dropdown below."
          >
            {browserLabel}
          </span>
          {isRunning && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Running…
            </span>
          )}
          <span
            className={cn(
              "h-2 w-2 rounded-full shrink-0",
              hasStream ? "bg-emerald-500" : "bg-muted-foreground/50"
            )}
            title={hasStream ? "Connected" : "Disconnected"}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden basis-0">
        <BrowserCanvas className="flex-1 min-h-0 min-w-0 w-full h-full overflow-hidden" />
      </div>
    </section>
  );
}
