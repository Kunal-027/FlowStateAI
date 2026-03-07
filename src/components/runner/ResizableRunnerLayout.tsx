"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TestCasesSidebar } from "@/components/runner/TestCasesSidebar";
import { RunBar } from "@/components/runner/RunBar";
import { MonitorPanel } from "@/components/runner/MonitorPanel";
import { ConsoleOverlay } from "@/components/runner/ConsoleOverlay";
import { ReportsPanel } from "@/components/runner/ReportsPanel";
import { PanelResizer } from "@/components/runner/PanelResizer";
import { loadTestCasesFromStorage, loadTestCasesFromBackup } from "@/lib/testCasePersistence";
import { getMockTestCases } from "@/lib/mockTestCases";
import { useExecutionStore } from "@/store/useExecutionStore";
import { useReportStore } from "@/store/useReportStore";
import { cn } from "@/lib/utils";

const STORAGE_KEY_SIDEBAR = "flowstate-runner-sidebar-width";
const STORAGE_KEY_CONSOLE = "flowstate-runner-console-width";

const DEFAULT_SIDEBAR = 280;
const DEFAULT_CONSOLE = 320;
const MIN_SIDEBAR = 200;
const MAX_SIDEBAR = 520;
const MIN_CONSOLE = 240;
const MAX_CONSOLE = 560;

function readStored(key: string, defaultVal: number, min: number, max: number): number {
  if (typeof window === "undefined") return defaultVal;
  try {
    const v = parseInt(localStorage.getItem(key) ?? "", 10);
    if (!Number.isNaN(v) && v >= min && v <= max) return v;
  } catch {
    // ignore
  }
  return defaultVal;
}

function writeStored(key: string, value: number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore
  }
}

type MainTab = "monitor" | "reports";

export function ResizableRunnerLayout({ children }: { children: React.ReactNode }) {
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR);
  const [consoleWidth, setConsoleWidth] = useState(DEFAULT_CONSOLE);
  const [mainTab, setMainTab] = useState<MainTab>("monitor");
  const setTestCases = useExecutionStore((s) => s.setTestCases);
  const restoredRef = useRef(false);
  const shouldOpenReportsTab = useReportStore((s) => s.shouldOpenReportsTab);
  const clearShouldOpenReportsTab = useReportStore((s) => s.clearShouldOpenReportsTab);
  const shouldOpenMonitorTab = useReportStore((s) => s.shouldOpenMonitorTab);
  const clearShouldOpenMonitorTab = useReportStore((s) => s.clearShouldOpenMonitorTab);

  useEffect(() => {
    setSidebarWidth(readStored(STORAGE_KEY_SIDEBAR, DEFAULT_SIDEBAR, MIN_SIDEBAR, MAX_SIDEBAR));
    setConsoleWidth(readStored(STORAGE_KEY_CONSOLE, DEFAULT_CONSOLE, MIN_CONSOLE, MAX_CONSOLE));
  }, []);

  /** When a run completes, switch to Reports tab and show the new report. */
  useEffect(() => {
    if (shouldOpenReportsTab) {
      setMainTab("reports");
      clearShouldOpenReportsTab();
    }
  }, [shouldOpenReportsTab, clearShouldOpenReportsTab]);

  /** When user clicks Run, switch to Monitor tab so they see the browser/console. */
  useEffect(() => {
    if (shouldOpenMonitorTab) {
      setMainTab("monitor");
      clearShouldOpenMonitorTab();
    }
  }, [shouldOpenMonitorTab, clearShouldOpenMonitorTab]);

  /** Restore test cases from localStorage or seed with mocks when the list is empty (so tests don’t “disappear” on refresh). */
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const saved = loadTestCasesFromStorage();
    if (saved !== null && saved.length > 0) {
      setTestCases(saved);
    } else {
      const backup = loadTestCasesFromBackup();
      if (backup !== null && backup.length > 0) {
        setTestCases(backup);
      } else {
        setTestCases(getMockTestCases());
      }
    }
  }, [setTestCases]);

  const handleSidebarDrag = useCallback((delta: number) => {
    setSidebarWidth((w) => {
      const next = Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w + delta));
      writeStored(STORAGE_KEY_SIDEBAR, next);
      return next;
    });
  }, []);

  const handleConsoleDrag = useCallback((delta: number) => {
    setConsoleWidth((w) => {
      const next = Math.min(MAX_CONSOLE, Math.max(MIN_CONSOLE, w + delta));
      writeStored(STORAGE_KEY_CONSOLE, next);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <div
        className="shrink-0 flex flex-col overflow-hidden"
        style={{ width: sidebarWidth, minWidth: MIN_SIDEBAR, maxWidth: MAX_SIDEBAR }}
      >
        <TestCasesSidebar className="w-full min-w-0" />
      </div>
      <PanelResizer direction="vertical" onDrag={handleSidebarDrag} />
      <main className="flex flex-1 flex-col min-h-0 overflow-hidden p-4 gap-3 min-w-0">
        <div className="flex-1 min-h-0 flex flex-col gap-3 overflow-hidden">
          <RunBar />
          <div className="shrink-0 flex gap-0 border-b border-border">
            <button
              type="button"
              onClick={() => setMainTab("monitor")}
              className={cn(
                "px-3 py-2 text-sm font-medium rounded-t-md transition-colors",
                mainTab === "monitor"
                  ? "bg-background text-foreground border border-border border-b-0 -mb-px"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Monitor
            </button>
            <button
              type="button"
              onClick={() => setMainTab("reports")}
              className={cn(
                "px-3 py-2 text-sm font-medium rounded-t-md transition-colors",
                mainTab === "reports"
                  ? "bg-background text-foreground border border-border border-b-0 -mb-px"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              Reports
            </button>
          </div>
          {mainTab === "monitor" && (
            <div className="flex-1 min-h-0 flex flex-row gap-0 overflow-hidden">
              <div
                className="shrink-0 flex flex-col overflow-hidden min-h-0"
                style={{ width: consoleWidth, minWidth: MIN_CONSOLE, maxWidth: MAX_CONSOLE }}
              >
                <ConsoleOverlay className="flex-1 min-w-0 w-full" />
              </div>
              <PanelResizer direction="vertical" onDrag={handleConsoleDrag} />
              <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden basis-0">
                <MonitorPanel />
              </div>
            </div>
          )}
          {mainTab === "reports" && (
            <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
              <ReportsPanel className="h-full" />
            </div>
          )}
        </div>
        {children}
      </main>
    </div>
  );
}
