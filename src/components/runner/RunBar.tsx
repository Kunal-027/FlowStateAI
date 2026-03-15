"use client";

import { useRef, useEffect } from "react";
import { useExecutionStore, getExecutionState } from "@/store/useExecutionStore";
import { useReportStore, buildReportFromTestCase } from "@/store/useReportStore";
import { startMockExecution } from "@/services/mock";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Play } from "lucide-react";

/**
 * Shows when a test case is selected in the sidebar and its status is QUEUED.
 * Renders the selected test name and a Run button; clicking Run switches state to RUNNING
 * and starts the mock execution service (logs every 2s, SUCCESS after 6s).
 */
const BROWSER_LABELS: Record<string, string> = {
  chromium: "Chromium",
  firefox: "Firefox",
  webkit: "WebKit",
};

export function RunBar({ className }: { className?: string }) {
  const testCases = useExecutionStore((s) => s.testCases);
  const activeTestCaseId = useExecutionStore((s) => s.activeTestCaseId);
  const selectedBrowser = useExecutionStore((s) => s.selectedBrowser);
  const mockCleanupRef = useRef<(() => void) | null>(null);

  const activeCase = activeTestCaseId
    ? testCases.find((tc) => tc.id === activeTestCaseId)
    : null;
  const isQueued = activeCase?.status === "queued";
  const browserLabel = BROWSER_LABELS[selectedBrowser] ?? selectedBrowser;

  useEffect(() => {
    return () => {
      mockCleanupRef.current?.();
    };
  }, []);

  /** Run: pull latest test case and steps from store, then start execution. */
  const handleRun = () => {
    const store = getExecutionState();
    const current = store.activeTestCaseId
      ? store.testCases.find((tc) => tc.id === store.activeTestCaseId)
      : null;
    if (!current || current.status !== "queued") return;

    useReportStore.getState().openMonitorTab();

    mockCleanupRef.current?.();

    const id = current.id;
    const steps = current.steps;
    store.clearLogs();
    store.updateTestCase(id, { status: "running", startedAt: new Date().toISOString() });
    store.setActiveTestCase(id);

    mockCleanupRef.current = startMockExecution(
      id,
      {
        addLog: (entry) => store.addLog(entry),
        updateTestCase: (tid, updates) => store.updateTestCase(tid, updates as Partial<TestCase>),
        setActiveStep: store.setActiveStep,
        updateStep: store.updateStep,
      },
      {
        getBridgeSend: () => getExecutionState().bridgeSend,
        getExecuteStep: () => getExecutionState().executeStep,
        getSessionId: () => getExecutionState().streamSessionId,
        getStepDelayMs: () => getExecutionState().stepDelayMs,
        steps,
        onRunComplete: (testCaseId) => {
          const tc = getExecutionState().testCases.find((c) => c.id === testCaseId);
          if (tc && (tc.status === "success" || tc.status === "failed")) {
            useReportStore.getState().addReport(buildReportFromTestCase(tc));
          }
        },
      }
    );
  };

  if (!activeCase || !isQueued) return null;

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 rounded-lg border border-border bg-card/50 px-3 py-2 shrink-0",
        className
      )}
    >
      <span className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
        <span>Selected: <span className="font-medium text-foreground">{activeCase.name}</span></span>
        <span className="text-muted-foreground/80">·</span>
        <span title="Test will run in this browser">Browser: <span className="font-medium text-foreground">{browserLabel}</span></span>
      </span>
      <Button size="sm" onClick={handleRun} className="gap-1.5">
        <Play className="h-3.5 w-3.5" />
        Run
      </Button>
    </div>
  );
}
