"use client";

import { useState } from "react";
import { useExecutionStore } from "@/store/useExecutionStore";
import { parseInstructionsToSteps } from "@/lib/parser";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BrowserChannel } from "@/types/execution";

const BROWSER_OPTIONS: { value: BrowserChannel; label: string }[] = [
  { value: "chromium", label: "Chromium" },
  { value: "firefox", label: "Firefox" },
  { value: "webkit", label: "WebKit" },
];

/** Step delay options: wait after each step so user can see where it clicked. */
const STEP_DELAY_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "0 s" },
  { value: 500, label: "0.5 s" },
  { value: 1000, label: "1 s" },
  { value: 1500, label: "1.5 s" },
  { value: 2000, label: "2 s" },
  { value: 2500, label: "2.5 s" },
  { value: 3000, label: "3 s" },
  { value: 4000, label: "4 s" },
  { value: 5000, label: "5 s" },
];

/** Generates a unique id for test cases. */
function generateTestCaseId(): string {
  return `tc-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Toolbar: browser selector dropdown and "Add test case" form (name + one instruction per line).
 * New test cases are added to the store with status "queued".
 */
export function RunnerToolbar({ className }: { className?: string }) {
  const selectedBrowser = useExecutionStore((s) => s.selectedBrowser);
  const setSelectedBrowser = useExecutionStore((s) => s.setSelectedBrowser);
  const stepDelayMs = useExecutionStore((s) => s.stepDelayMs);
  const setStepDelayMs = useExecutionStore((s) => s.setStepDelayMs);
  const addTestCase = useExecutionStore((s) => s.addTestCase);
  const addLog = useExecutionStore((s) => s.addLog);

  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState("");
  const [instructionsText, setInstructionsText] = useState("");

  /** Validates name and instructions, parses steps, adds the test case to the store with status "queued", and resets the form. */
  const handleAddTestCase = () => {
    const trimmedName = name.trim();
    const lines = instructionsText
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (!trimmedName) {
      addLog({ level: "warn", message: "Test case name is required." });
      return;
    }
    if (lines.length === 0) {
      addLog({ level: "warn", message: "Add at least one instruction (one per line)." });
      return;
    }
    const steps = parseInstructionsToSteps(
      lines.map((instruction, order) => ({ instruction, order }))
    );
    const testCase = {
      id: generateTestCaseId(),
      name: trimmedName,
      steps,
      status: "queued" as const,
    };
    addTestCase(testCase);
    addLog({ level: "info", message: `Added test case "${trimmedName}" with ${steps.length} step(s).` });
    setName("");
    setInstructionsText("");
    setShowAddForm(false);
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label htmlFor="browser-select" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Browser (test runs in)
          </label>
          <select
            id="browser-select"
            value={selectedBrowser}
            onChange={(e) => setSelectedBrowser(e.target.value as BrowserChannel)}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {BROWSER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="step-delay-select" className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Step delay
          </label>
          <select
            id="step-delay-select"
            value={stepDelayMs}
            onChange={(e) => setStepDelayMs(Number(e.target.value))}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            title="Wait time after each step so you can see where it clicked (0–5 s)"
          >
            {STEP_DELAY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowAddForm((v) => !v)}
        >
          {showAddForm ? "Cancel" : "+ Add test case"}
        </Button>
      </div>

      {showAddForm && (
        <div className="rounded-md border border-border bg-card/50 p-3 space-y-3">
          <div>
            <label htmlFor="tc-name" className="block text-xs font-medium text-muted-foreground mb-1">
              Test case name
            </label>
            <input
              id="tc-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Login flow"
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label htmlFor="tc-instructions" className="block text-xs font-medium text-muted-foreground mb-1">
              Instructions (one per line)
            </label>
            <textarea
              id="tc-instructions"
              value={instructionsText}
              onChange={(e) => setInstructionsText(e.target.value)}
              placeholder={"navigate https://example.com\nclick Sign In\nfill email with user@test.com"}
              rows={4}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Supported: click, fill … with …, navigate, assert, select, hover, wait
            </p>
          </div>
          <Button size="sm" onClick={handleAddTestCase}>
            Add to queue
          </Button>
        </div>
      )}
    </div>
  );
}
