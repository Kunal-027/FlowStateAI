"use client";

import { useEffect, useRef, useState } from "react";
import { useExecutionStore, getExecutionState } from "@/store/useExecutionStore";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { saveTestCasesToStorage, loadTestCasesFromBackup, hasTestCasesBackup } from "@/lib/testCasePersistence";
import { getMockTestCases } from "@/lib/mockTestCases";
import { startMockExecution } from "@/services/mock";
import { parseSingleInstruction } from "@/lib/parser";
import { useReportStore, buildReportFromTestCase } from "@/store/useReportStore";
import type { TestCase, TestStep } from "@/types/execution";
import { Play, Loader2, ChevronDown, ChevronRight, Plus, Trash2, Save, Square, Pause, PlayCircle, Pencil } from "lucide-react";

/** Editable step: input that updates store on change, plus delete button. Syncs with monitor by highlighting active step and scrolling into view. */
function EditableStep({
  testCaseId,
  step,
  isActive,
  stepRef,
  onUpdateStep,
  onDeleteStep,
  canDelete,
}: {
  testCaseId: string;
  step: TestStep;
  isActive: boolean;
  stepRef?: React.RefObject<HTMLDivElement | null>;
  onUpdateStep: (testCaseId: string, stepId: string, updates: Partial<TestStep>) => void;
  onDeleteStep: (testCaseId: string, stepId: string) => void;
  onStepBlur?: () => void;
  canDelete: boolean;
}) {
  const handleChange = (value: string) => {
    onUpdateStep(testCaseId, step.id, {
      instruction: value,
      payload: parseSingleInstruction(value),
    });
  };

  return (
    <div
      ref={stepRef}
      className={cn(
        "flex items-center gap-1 py-1 pl-6 pr-1 group rounded transition-colors",
        isActive && "bg-primary/15 ring-1 ring-primary/40"
      )}
    >
      <span className={cn("shrink-0 text-[10px] w-5", isActive ? "text-primary font-medium" : "text-muted-foreground")}>
        {step.order + 1}.
      </span>
      <input
        type="text"
        value={step.instruction}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={() => onStepBlur?.()}
        className={cn(
          "flex-1 min-w-0 rounded border border-border bg-background px-2 py-1 text-xs text-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring",
          isActive && "border-primary/50"
        )}
        placeholder="e.g. click Submit"
      />
      {canDelete && (
        <button
          type="button"
          onClick={() => onDeleteStep(testCaseId, step.id)}
          className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          title="Delete step"
          aria-label="Delete step"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Single row: name, status badge, expand chevron, Play / Stop / Pause / Resume. Expanded: list of editable steps (active step highlighted and synced with monitor). */
function TestCaseRow({
  testCase,
  activeId,
  activeStepId,
  activeStepRef,
  expanded,
  isPaused,
  onSelect,
  onPlay,
  onStop,
  onPause,
  onResume,
  onToggleExpand,
  onUpdateStep,
  onUpdateTestCase,
  onAddStep,
  onInsertStep,
  onDeleteStep,
  onStepBlur,
}: {
  testCase: TestCase;
  activeId: string | null;
  activeStepId: string | null;
  activeStepRef: React.RefObject<HTMLDivElement | null>;
  expanded: boolean;
  isPaused: boolean;
  onSelect: (id: string) => void;
  onPlay: (id: string) => void;
  onStop: (id: string) => void;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onUpdateStep: (testCaseId: string, stepId: string, updates: Partial<TestStep>) => void;
  onUpdateTestCase: (testCaseId: string, updates: Partial<TestCase>) => void;
  onAddStep: (testCaseId: string) => void;
  onInsertStep: (testCaseId: string, afterOrder: number) => void;
  onDeleteStep: (testCaseId: string, stepId: string) => void;
  onStepBlur?: () => void;
}) {
  const isActive = activeId === testCase.id;
  const isRunning = testCase.status === "running";
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editName, setEditName] = useState(testCase.name);
  useEffect(() => {
    if (!isEditingTitle) setEditName(testCase.name);
  }, [testCase.name, isEditingTitle]);

  const handleSaveTitle = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== testCase.name) {
      onUpdateTestCase(testCase.id, { name: trimmed });
    } else {
      setEditName(testCase.name);
    }
    setIsEditingTitle(false);
  };

  const badgeVariant =
    testCase.status === "queued"
      ? "queued"
      : testCase.status === "running"
        ? "running"
        : testCase.status === "success"
          ? "success"
          : "failed";

  return (
    <li
      className={cn(
        "rounded-md border border-transparent transition-colors",
        isActive && "border-border bg-muted/70"
      )}
    >
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(testCase.id);
          }}
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          title={expanded ? "Collapse steps" : "Expand steps"}
        >
          {expanded ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </button>
        <div className="flex-1 min-w-0 flex items-center gap-1">
          {isEditingTitle ? (
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSaveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSaveTitle();
                if (e.key === "Escape") {
                  setEditName(testCase.name);
                  setIsEditingTitle(false);
                }
              }}
              autoFocus
              className={cn(
                "flex-1 min-w-0 rounded border border-primary/50 bg-background px-1.5 py-0.5 text-xs text-foreground",
                "focus:outline-none focus:ring-1 focus:ring-ring"
              )}
              aria-label="Edit test case title"
            />
          ) : (
            <>
              <button
                type="button"
                onClick={() => onSelect(testCase.id)}
                className="flex-1 min-w-0 text-left text-sm"
              >
                <span className="block truncate text-foreground">{testCase.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {testCase.steps.length} step{testCase.steps.length !== 1 ? "s" : ""}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditName(testCase.name);
                  setIsEditingTitle(true);
                }}
                className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Edit test case title"
                aria-label="Edit test case title"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </>
          )}
        </div>
        <Badge variant={badgeVariant} className="shrink-0 text-[10px] px-1.5">
          {testCase.status === "success" ? "Pass" : testCase.status}
        </Badge>
        {isRunning ? (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onStop(testCase.id);
              }}
              className="shrink-0 rounded p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-destructive hover:bg-destructive/15 transition-colors"
              title="Stop"
              aria-label="Stop test"
            >
              <Square className="h-3.5 w-3.5" fill="currentColor" />
            </button>
            {isPaused ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onResume(testCase.id);
                }}
                className="shrink-0 rounded p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-accent hover:bg-accent/20 transition-colors"
                title="Resume"
                aria-label="Resume test"
              >
                <PlayCircle className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onPause(testCase.id);
                }}
                className="shrink-0 rounded p-1.5 min-w-[28px] min-h-[28px] flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Pause"
                aria-label="Pause test"
              >
                <Pause className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onPlay(testCase.id);
            }}
            className={cn(
              "shrink-0 rounded p-1.5 min-w-[32px] min-h-[32px] flex items-center justify-center transition-colors",
              "text-accent hover:bg-accent/20"
            )}
            title="Run test"
            aria-label="Run test"
          >
            <Play className="h-4 w-4" />
          </button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-border bg-muted/30 pb-2 pt-1">
          {testCase.steps.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">No steps. Add a step below.</p>
          ) : (
            testCase.steps
              .slice()
              .sort((a, b) => a.order - b.order)
              .flatMap((step) => [
                <EditableStep
                  key={step.id}
                  testCaseId={testCase.id}
                  step={step}
                  isActive={activeStepId === step.id}
                  stepRef={activeStepId === step.id ? activeStepRef : undefined}
                  onUpdateStep={onUpdateStep}
                  onDeleteStep={onDeleteStep}
                  onStepBlur={onStepBlur}
                  canDelete={true}
                />,
                <div key={`insert-after-${step.id}`} className="flex items-center pl-6 pr-1 py-0.5">
                  <button
                    type="button"
                    onClick={() => onInsertStep(testCase.id, step.order)}
                    className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                    title="Add step below"
                  >
                    <Plus className="h-3 w-3" />
                    Add below
                  </button>
                </div>,
              ])
          )}
          <div className="px-4 pl-6 pt-1">
            <button
              type="button"
              onClick={() => onAddStep(testCase.id)}
              className={cn(
                "flex items-center gap-1.5 rounded border border-dashed border-border px-2 py-1.5 text-xs text-muted-foreground",
                "hover:border-foreground/40 hover:text-foreground hover:bg-muted/50 transition-colors"
              )}
              title="Add step"
            >
              <Plus className="h-3.5 w-3.5" />
              Add step
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Dynamic sidebar: list of test cases (mock-seeded if empty), each with name, status badge, and Play.
 * Clicking Play sets the case to Running, updates the store, and streams simulated console logs.
 */
export function TestCasesSidebar({ className }: { className?: string }) {
  const testCases = useExecutionStore((s) => s.testCases);
  const setTestCases = useExecutionStore((s) => s.setTestCases);
  const activeTestCaseId = useExecutionStore((s) => s.activeTestCaseId);
  const activeStepId = useExecutionStore((s) => s.activeStepId);
  const setActiveTestCase = useExecutionStore((s) => s.setActiveTestCase);
  const setActiveStep = useExecutionStore((s) => s.setActiveStep);
  const updateTestCase = useExecutionStore((s) => s.updateTestCase);
  const updateStep = useExecutionStore((s) => s.updateStep);
  const addStep = useExecutionStore((s) => s.addStep);
  const insertStep = useExecutionStore((s) => s.insertStep);
  const deleteStep = useExecutionStore((s) => s.deleteStep);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [paused, setPaused] = useState(false);
  const activeStepRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(false);
  const resumeResolveRef = useRef<(() => void) | null>(null);
  const stepSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Sync sidebar with monitor: scroll the currently running step into view. */
  useEffect(() => {
    if (activeStepId && activeStepRef.current) {
      activeStepRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [activeStepId]);

  /** Test cases are restored once by ResizableRunnerLayout (localStorage or seed). */

  /** Sets the currently selected test case in the store (used when clicking a row). */
  const handleSelect = (id: string) => setActiveTestCase(id);

  const mockCleanupRef = useRef<(() => void) | null>(null);

  /** Cleans up the mock execution timers and step-save debounce on unmount. */
  useEffect(() => {
    return () => {
      mockCleanupRef.current?.();
      if (stepSaveTimeoutRef.current) clearTimeout(stepSaveTimeoutRef.current);
    };
  }, []);

  /** Toggle expand/collapse for a test case. */
  const handleToggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  /** Wait-if-paused: returns a promise that resolves when not paused (used by execution loop). */
  const getWaitIfPaused = () =>
    new Promise<void>((resolve) => {
      if (!pausedRef.current) {
        resolve();
        return;
      }
      resumeResolveRef.current = resolve;
    });

  /** Run: pull latest test case and steps from store, then start execution. */
  const handlePlay = (id: string) => {
    const store = getExecutionState();
    const tc = store.testCases.find((t) => t.id === id);
    if (!tc || tc.status === "running") return;

    useReportStore.getState().openMonitorTab();

    mockCleanupRef.current?.();
    setPaused(false);
    pausedRef.current = false;
    resumeResolveRef.current = null;

    store.clearLogs();
    store.setActiveStep(null);
    tc.steps.forEach((s) => store.updateStep(id, s.id, { status: "idle" }));
    store.updateTestCase(id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    store.setActiveTestCase(id);
    setExpandedId(id); // expand so user sees steps synced with monitor

    const steps = tc.steps;
    const actions = {
      addLog: (entry: Parameters<typeof store.addLog>[0]) => store.addLog(entry),
      updateTestCase: (tid: string, updates: Parameters<typeof store.updateTestCase>[1]) => store.updateTestCase(tid, updates),
      setActiveStep: store.setActiveStep,
      updateStep: store.updateStep,
    };
    const opts = {
      getBridgeSend: () => getExecutionState().bridgeSend,
      getExecuteStep: () => getExecutionState().executeStep,
      getSessionId: () => getExecutionState().streamSessionId,
      getStepDelayMs: () => getExecutionState().stepDelayMs,
      getWaitIfPaused,
      steps,
      onRunComplete: (testCaseId) => {
        const tc = getExecutionState().testCases.find((c) => c.id === testCaseId);
        if (tc && (tc.status === "success" || tc.status === "failed")) {
          useReportStore.getState().addReport(buildReportFromTestCase(tc));
        }
      },
    };

    mockCleanupRef.current = startMockExecution(id, actions, opts);
  };

  /** Stop the running test case. */
  const handleStop = (id: string) => {
    if (activeTestCaseId !== id) return;
    setPaused(false);
    pausedRef.current = false;
    resumeResolveRef.current?.();
    resumeResolveRef.current = null;
    mockCleanupRef.current?.();
    mockCleanupRef.current = null;
    const store = getExecutionState();
    const activeStepId = store.activeStepId;
    if (activeStepId) {
      store.updateStep(id, activeStepId, { status: "failed", error: "Stopped by user" });
    }
    store.setActiveStep(null);
    store.setActiveTestCase(null);
    store.updateTestCase(id, {
      status: "failed",
      error: "Stopped by user",
      completedAt: new Date().toISOString(),
    });
    store.addLog({ level: "info", message: "Test stopped by user.", testCaseId: id });
    const send = store.bridgeSend;
    const sessionId = store.streamSessionId;
    if (send && sessionId) send({ type: "test_failed", sessionId });
  };

  /** Pause the running test (next step will wait until Resume). */
  const handlePause = (id: string) => {
    if (activeTestCaseId !== id) return;
    setPaused(true);
    pausedRef.current = true;
  };

  /** Resume the paused test. */
  const handleResume = (id: string) => {
    if (activeTestCaseId !== id) return;
    setPaused(false);
    pausedRef.current = false;
    resumeResolveRef.current?.();
    resumeResolveRef.current = null;
  };

  const handleSave = () => {
    // Commit any in-progress title edit (blur triggers handleSaveTitle in the row)
    (document.activeElement as HTMLElement | null)?.blur();
    // Flush step-save debounce so pending step edits are not lost, then persist current store
    if (stepSaveTimeoutRef.current) {
      clearTimeout(stepSaveTimeoutRef.current);
      stepSaveTimeoutRef.current = null;
    }
    window.setTimeout(() => {
      saveTestCasesToStorage(getExecutionState().testCases);
      setSavedFeedback(true);
      window.setTimeout(() => setSavedFeedback(false), 2000);
    }, 0);
  };

  /** Update test case and persist to storage when name (or other fields) change so edits survive refresh. */
  const handleUpdateTestCase = (testCaseId: string, updates: Partial<TestCase>) => {
    updateTestCase(testCaseId, updates);
    saveTestCasesToStorage(getExecutionState().testCases);
  };

  /** Update step and persist to storage after a short debounce so step instruction edits (e.g. Apple → Boat) survive refresh and run. */
  const handleUpdateStep = (testCaseId: string, stepId: string, updates: Partial<TestStep>) => {
    updateStep(testCaseId, stepId, updates);
    if (stepSaveTimeoutRef.current) clearTimeout(stepSaveTimeoutRef.current);
    stepSaveTimeoutRef.current = setTimeout(() => {
      saveTestCasesToStorage(getExecutionState().testCases);
      stepSaveTimeoutRef.current = null;
    }, 600);
  };

  /** When user leaves a step input (blur), persist immediately so Save and Play use the latest step text. */
  const handleStepBlur = () => {
    if (stepSaveTimeoutRef.current) {
      clearTimeout(stepSaveTimeoutRef.current);
      stepSaveTimeoutRef.current = null;
    }
    saveTestCasesToStorage(getExecutionState().testCases);
  };

  return (
    <aside
      className={cn(
        "flex w-64 shrink-0 flex-col border-r border-border bg-card/50",
        className
      )}
    >
      <div className="border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <h1 className="text-sm font-semibold text-foreground">Test Cases</h1>
          <div className="flex items-center gap-1">
            {testCases.length === 0 && hasTestCasesBackup() && (
              <button
                type="button"
                onClick={() => {
                  const backup = loadTestCasesFromBackup();
                  if (backup?.length) setTestCases(backup);
                }}
                className={cn(
                  "shrink-0 rounded border border-primary/50 bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors",
                  "hover:bg-primary/20"
                )}
                title="Restore tests from last backup (before they were cleared)"
              >
                Restore previous
              </button>
            )}
            <button
              type="button"
              onClick={() => setTestCases(getMockTestCases())}
              className={cn(
                "shrink-0 rounded border border-border px-2 py-1 text-xs font-medium transition-colors",
                "hover:bg-muted hover:border-foreground/30"
              )}
              title="Load sample test cases (replaces current list)"
            >
              Load samples
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={testCases.length === 0 || savedFeedback}
              aria-label="Save test cases"
              data-testid="save-test-cases"
              className={cn(
                "shrink-0 rounded border border-border px-2 py-1 text-xs font-medium transition-colors",
                "hover:bg-muted hover:border-foreground/30 disabled:opacity-50 disabled:pointer-events-none",
                savedFeedback && "text-green-600 border-green-600/50"
              )}
              title="Save test cases to browser storage (persists after refresh)"
            >
              {savedFeedback ? (
                "Saved!"
              ) : (
                <>
                  <Save className="inline h-3 w-3 mr-1 align-middle" aria-hidden />
                  Save
                </>
              )}
            </button>
          </div>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Click Play to run. Save to keep after refresh.
        </p>
      </div>
      <ScrollArea className="flex-1 p-2">
        <ul className="space-y-1">
          {testCases.length === 0 ? (
            <li className="px-2 py-4 text-center text-xs text-muted-foreground">
              No test cases yet.
            </li>
          ) : (
            testCases.map((tc) => (
              <TestCaseRow
                key={tc.id}
                testCase={tc}
                activeId={activeTestCaseId}
                activeStepId={activeStepId}
                activeStepRef={activeStepRef}
                expanded={expandedId === tc.id}
                isPaused={paused && activeTestCaseId === tc.id}
                onSelect={handleSelect}
                onPlay={handlePlay}
                onStop={handleStop}
                onPause={handlePause}
                onResume={handleResume}
                onToggleExpand={handleToggleExpand}
                onUpdateStep={handleUpdateStep}
                onUpdateTestCase={handleUpdateTestCase}
                onAddStep={addStep}
                onInsertStep={insertStep}
                onDeleteStep={deleteStep}
                onStepBlur={handleStepBlur}
              />
            ))
          )}
        </ul>
      </ScrollArea>
    </aside>
  );
}
