"use client";

import { useEffect, useRef, useState } from "react";
import { useExecutionStore, getExecutionState } from "@/store/useExecutionStore";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { saveTestCasesToStorage } from "@/lib/testCasePersistence";
import { startMockExecution } from "@/services/mock";
import { parseSingleInstruction } from "@/lib/parser";
import type { TestCase, TestStep } from "@/types/execution";
import { Play, Loader2, ChevronDown, ChevronRight, Plus, Trash2, Save } from "lucide-react";

/** Editable step: input that updates store on change, plus delete button. */
function EditableStep({
  testCaseId,
  step,
  onUpdateStep,
  onDeleteStep,
  canDelete,
}: {
  testCaseId: string;
  step: TestStep;
  onUpdateStep: (testCaseId: string, stepId: string, updates: Partial<TestStep>) => void;
  onDeleteStep: (testCaseId: string, stepId: string) => void;
  canDelete: boolean;
}) {
  const handleChange = (value: string) => {
    onUpdateStep(testCaseId, step.id, {
      instruction: value,
      payload: parseSingleInstruction(value),
    });
  };

  return (
    <div className="flex items-center gap-1 py-1 pl-6 pr-1 group">
      <span className="shrink-0 text-[10px] text-muted-foreground w-5">{step.order + 1}.</span>
      <input
        type="text"
        value={step.instruction}
        onChange={(e) => handleChange(e.target.value)}
        className={cn(
          "flex-1 min-w-0 rounded border border-border bg-background px-2 py-1 text-xs text-foreground",
          "focus:outline-none focus:ring-1 focus:ring-ring"
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

/** Single row: name, status badge, expand chevron, Play. Expanded: list of editable steps, add/delete. */
function TestCaseRow({
  testCase,
  activeId,
  expanded,
  onSelect,
  onPlay,
  onToggleExpand,
  onUpdateStep,
  onAddStep,
  onDeleteStep,
}: {
  testCase: TestCase;
  activeId: string | null;
  expanded: boolean;
  onSelect: (id: string) => void;
  onPlay: (id: string) => void;
  onToggleExpand: (id: string) => void;
  onUpdateStep: (testCaseId: string, stepId: string, updates: Partial<TestStep>) => void;
  onAddStep: (testCaseId: string) => void;
  onDeleteStep: (testCaseId: string, stepId: string) => void;
}) {
  const isActive = activeId === testCase.id;
  const isRunning = testCase.status === "running";

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
        <Badge variant={badgeVariant} className="shrink-0 text-[10px] px-1.5">
          {testCase.status}
        </Badge>
        <button
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!isRunning) onPlay(testCase.id);
          }}
          disabled={isRunning}
          className={cn(
            "shrink-0 rounded p-1.5 min-w-[32px] min-h-[32px] flex items-center justify-center transition-colors",
            isRunning
              ? "text-muted-foreground cursor-not-allowed"
              : "text-accent hover:bg-accent/20"
          )}
          title={isRunning ? "Running…" : "Run test"}
          aria-label={isRunning ? "Running" : "Run test"}
        >
          {isRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </button>
      </div>
      {expanded && (
        <div className="border-t border-border bg-muted/30 pb-2 pt-1">
          {testCase.steps.length === 0 ? (
            <p className="px-4 py-2 text-xs text-muted-foreground">No steps. Add a step below.</p>
          ) : (
            testCase.steps
              .slice()
              .sort((a, b) => a.order - b.order)
              .map((step) => (
                <EditableStep
                  key={step.id}
                  testCaseId={testCase.id}
                  step={step}
                  onUpdateStep={onUpdateStep}
                  onDeleteStep={onDeleteStep}
                  canDelete={true}
                />
              ))
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
  const setActiveTestCase = useExecutionStore((s) => s.setActiveTestCase);
  const updateTestCase = useExecutionStore((s) => s.updateTestCase);
  const updateStep = useExecutionStore((s) => s.updateStep);
  const addStep = useExecutionStore((s) => s.addStep);
  const deleteStep = useExecutionStore((s) => s.deleteStep);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [savedFeedback, setSavedFeedback] = useState(false);

  /** Test cases are restored once by ResizableRunnerLayout (localStorage or seed). */

  /** Sets the currently selected test case in the store (used when clicking a row). */
  const handleSelect = (id: string) => setActiveTestCase(id);

  const mockCleanupRef = useRef<(() => void) | null>(null);

  /** Cleans up the mock execution timers on unmount so we do not update state after the component is gone. */
  useEffect(() => {
    return () => {
      mockCleanupRef.current?.();
    };
  }, []);

  /** Toggle expand/collapse for a test case. */
  const handleToggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  /** Run: pull latest test case and steps from store, then start execution. */
  const handlePlay = (id: string) => {
    const store = getExecutionState();
    const tc = store.testCases.find((t) => t.id === id);
    if (!tc || tc.status === "running") return;

    mockCleanupRef.current?.();

    store.clearLogs();
    store.updateTestCase(id, {
      status: "running",
      startedAt: new Date().toISOString(),
    });
    store.setActiveTestCase(id);

    const steps = tc.steps;
    const actions = {
      addLog: (entry: Parameters<typeof store.addLog>[0]) => store.addLog(entry),
      updateTestCase: (tid: string, updates: Parameters<typeof store.updateTestCase>[1]) => store.updateTestCase(tid, updates),
    };
    const opts = {
      getBridgeSend: () => getExecutionState().bridgeSend,
      getExecuteStep: () => getExecutionState().executeStep,
      getSessionId: () => getExecutionState().streamSessionId,
      getStepDelayMs: () => getExecutionState().stepDelayMs,
      steps,
    };

    mockCleanupRef.current = startMockExecution(id, actions, opts);
  };

  const handleSave = () => {
    const store = getExecutionState();
    saveTestCasesToStorage(store.testCases);
    setSavedFeedback(true);
    window.setTimeout(() => setSavedFeedback(false), 2000);
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
          <button
            type="button"
            onClick={handleSave}
            disabled={testCases.length === 0 || savedFeedback}
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
                expanded={expandedId === tc.id}
                onSelect={handleSelect}
                onPlay={handlePlay}
                onToggleExpand={handleToggleExpand}
                onUpdateStep={updateStep}
                onAddStep={addStep}
                onDeleteStep={deleteStep}
              />
            ))
          )}
        </ul>
      </ScrollArea>
    </aside>
  );
}
