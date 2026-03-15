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
import { Play, ChevronDown, ChevronRight, Plus, Trash2, Save, Square, Pause, PlayCircle, Pencil } from "lucide-react";

/** Editable Step */
function EditableStep({
  testCaseId,
  step,
  isActive,
  stepRef,
  onUpdateStep,
  onDeleteStep,
  onStepBlur,
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
      payload: parseSingleInstruction(value) ?? undefined,
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
        onBlur={onStepBlur}
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
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Test Case Row */
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
    <li className={cn("rounded-md border border-transparent", isActive && "border-border bg-muted/70")}>
      <div className="flex items-center gap-1 px-2 py-1.5">

        <button
          onClick={() => onToggleExpand(testCase.id)}
          className="p-0.5 text-muted-foreground hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

        <div className="flex-1 min-w-0 flex items-center gap-1">
          {isEditingTitle ? (
            <input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleSaveTitle}
              autoFocus
              className="flex-1 rounded border border-primary/50 px-1.5 py-0.5 text-xs"
            />
          ) : (
            <>
              <button
                onClick={() => onSelect(testCase.id)}
                className="flex-1 text-left text-sm"
              >
                <span className="truncate">{testCase.name}</span>
              </button>

              <button
                onClick={() => setIsEditingTitle(true)}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <Pencil className="h-3 w-3" />
              </button>
            </>
          )}
        </div>

        <Badge variant={badgeVariant} className="text-[10px]">
          {testCase.status}
        </Badge>

        {isRunning ? (
          <>
            <button onClick={() => onStop(testCase.id)} className="p-1.5 text-destructive">
              <Square className="h-3.5 w-3.5" />
            </button>

            {isPaused ? (
              <button onClick={() => onResume(testCase.id)} className="p-1.5">
                <PlayCircle className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button onClick={() => onPause(testCase.id)} className="p-1.5">
                <Pause className="h-3.5 w-3.5" />
              </button>
            )}
          </>
        ) : (
          <button onClick={() => onPlay(testCase.id)} className="p-1.5 text-accent">
            <Play className="h-4 w-4" />
          </button>
        )}
      </div>

      {expanded && (
        <div className="border-t border-border bg-muted/30 pb-2 pt-1">
          {testCase.steps.map((step) => (
            <EditableStep
              key={step.id}
              testCaseId={testCase.id}
              step={step}
              isActive={activeStepId === step.id}
              stepRef={activeStepId === step.id ? activeStepRef : undefined}
              onUpdateStep={onUpdateStep}
              onDeleteStep={onDeleteStep}
              onStepBlur={onStepBlur}
              canDelete
            />
          ))}

          <div className="px-4 pl-6 pt-1">
            <button
              onClick={() => onAddStep(testCase.id)}
              className="flex items-center gap-1 text-xs text-muted-foreground"
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

/** Sidebar */
export function TestCasesSidebar({ className }: { className?: string }) {
  const testCases = useExecutionStore((s) => s.testCases);
  const setTestCases = useExecutionStore((s) => s.setTestCases);

  const updateTestCase = useExecutionStore((s) => s.updateTestCase);
  const updateStep = useExecutionStore((s) => s.updateStep);
  const addStep = useExecutionStore((s) => s.addStep);
  const deleteStep = useExecutionStore((s) => s.deleteStep);

  const [savedFeedback, setSavedFeedback] = useState(false);
  const stepSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleUpdateTestCase = (testCaseId: string, updates: Partial<TestCase>) => {
    updateTestCase(testCaseId, updates);
    saveTestCasesToStorage(getExecutionState().testCases);
  };

  const handleUpdateStep = (testCaseId: string, stepId: string, updates: Partial<TestStep>) => {
    updateStep(testCaseId, stepId, updates);

    if (stepSaveTimeoutRef.current) clearTimeout(stepSaveTimeoutRef.current);

    stepSaveTimeoutRef.current = setTimeout(() => {
      saveTestCasesToStorage(getExecutionState().testCases);
    }, 600);
  };

  const handleStepBlur = () => {
    if (stepSaveTimeoutRef.current) {
      clearTimeout(stepSaveTimeoutRef.current);
    }

    saveTestCasesToStorage(getExecutionState().testCases);
  };

  const handleSave = () => {
    saveTestCasesToStorage(getExecutionState().testCases);
    setSavedFeedback(true);

    setTimeout(() => setSavedFeedback(false), 2000);
  };

  return (
    <aside className={cn("flex w-64 flex-col border-r border-border bg-card/50", className)}>
      <div className="border-b border-border p-3 flex justify-between items-center">
        <h1 className="text-sm font-semibold">Test Cases</h1>

        <button
          onClick={handleSave}
          disabled={savedFeedback}
          className="text-xs flex items-center gap-1"
        >
          <Save className="h-3 w-3" />
          {savedFeedback ? "Saved!" : "Save"}
        </button>
      </div>

      <ScrollArea className="flex-1 p-2">
        <ul className="space-y-1">
          {testCases.map((tc) => (
            <TestCaseRow
              key={tc.id}
              testCase={tc}
              activeId={null}
              activeStepId={null}
              activeStepRef={useRef(null)}
              expanded={true}
              isPaused={false}
              onSelect={() => {}}
              onPlay={() => {}}
              onStop={() => {}}
              onPause={() => {}}
              onResume={() => {}}
              onToggleExpand={() => {}}
              onUpdateStep={handleUpdateStep}
              onUpdateTestCase={handleUpdateTestCase}
              onAddStep={addStep}
              onDeleteStep={deleteStep}
              onStepBlur={handleStepBlur}
            />
          ))}
        </ul>
      </ScrollArea>
    </aside>
  );
}
