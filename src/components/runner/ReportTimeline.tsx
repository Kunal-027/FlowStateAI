"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { ReportStep } from "@/types/execution";
import { ChevronDown, ChevronRight, CheckCircle2, XCircle, Sparkles } from "lucide-react";

/** Single timeline row: instruction, status icon, optional self-healed badge; expandable when step has screenshot or failed details. */
function TimelineRow({
  step,
  isExpanded,
  onToggle,
}: {
  step: ReportStep;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isFailed = step.status === "failed";
  const hasScreenshot = step.screenshot != null;
  const hasFailureDetails = isFailed && (step.error != null || hasScreenshot);
  const canExpand = hasScreenshot || hasFailureDetails;

  return (
    <div className="rounded-md border border-border/80 bg-card/50 overflow-hidden">
      <button
        type="button"
        onClick={canExpand ? onToggle : undefined}
        className={cn(
          "w-full flex items-center gap-2 px-3 py-2 text-left text-sm",
          canExpand && "cursor-pointer hover:bg-muted/50"
        )}
      >
        <span className="shrink-0 text-muted-foreground w-5">
          {canExpand ? (
            isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )
          ) : null}
        </span>
        <span className="shrink-0">
          {step.status === "success" ? (
            <CheckCircle2 className="h-4 w-4 text-emerald-500" />
          ) : step.status === "failed" ? (
            <XCircle className="h-4 w-4 text-destructive" />
          ) : (
            <span className="h-4 w-4 rounded-full bg-muted" />
          )}
        </span>
        {step.selfHealed && (
          <span
            className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-500/20 text-violet-700 dark:text-violet-300"
            title="Step was self-healed by AI"
          >
            <Sparkles className="h-3 w-3" />
            Self-healed
          </span>
        )}
        {step.resolvedBy && (
          <span
            className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground"
            title={
              step.resolvedBy === "interpreter"
                ? "Step resolved by parser/semantic locator"
                : step.resolvedBy === "huggingface"
                  ? "Step resolved by Hugging Face LLM"
                  : step.resolvedBy === "claude"
                    ? "Step resolved by Claude (LLM)"
                    : "Step resolved by Claude (Visual Discovery)"
            }
          >
            {step.resolvedBy === "interpreter"
              ? "Interpreter"
              : step.resolvedBy === "huggingface"
                ? "Hugging Face"
                : step.resolvedBy === "claude"
                  ? "Claude (LLM)"
                  : "Claude (Visual)"}
          </span>
        )}
        {step.visualClick && (
          <span
            className="shrink-0 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/20 text-emerald-700 dark:text-emerald-300"
            title={step.discoveryReason ?? "Step succeeded via AI Visual Discovery (click by coordinates)"}
          >
            Visual Discovery
          </span>
        )}
        {step.visualClick && step.validationPassed === false && (
          <span className="shrink-0 text-[10px] text-amber-600 dark:text-amber-400" title="Post-click validation did not detect page change">
            (unverified)
          </span>
        )}
        <span className="min-w-0 flex-1 truncate font-medium">
          {step.order + 1}. {step.instruction}
        </span>
        {hasScreenshot && !isExpanded && (
          <span className="shrink-0 text-[10px] text-muted-foreground">Screenshot</span>
        )}
      </button>
      {canExpand && isExpanded && (
        <div className="border-t border-border/80 bg-muted/30 px-3 py-2 space-y-2">
          {isFailed && (step.error != null || step.instruction) && (
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <span className="text-muted-foreground">Expected:</span>
              <span className="text-foreground">{step.instruction}</span>
              <span className="text-muted-foreground">Actual:</span>
              <span className="text-destructive">{step.error ?? "Step failed"}</span>
            </div>
          )}
          {step.visualClick && step.discoveryReason && (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Visual Discovery:</span> {step.discoveryReason}
              {step.validationPassed === true && " · Validation passed (page changed)"}
              {step.validationPassed === false && " · Validation not confirmed"}
            </p>
          )}
          {step.screenshot && (
            <div className={isFailed ? "pt-1" : ""}>
              <p className="text-xs text-muted-foreground mb-1">
                {isFailed ? "Screenshot at failure:" : "Screenshot after step:"}
              </p>
              <img
                src={`data:image/png;base64,${step.screenshot}`}
                alt={isFailed ? "Step failure" : "Step result"}
                className="max-w-full rounded border border-border max-h-48 object-contain bg-background"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Searchable timeline of report steps; steps with screenshots or failed details are expandable. */
export function ReportTimeline({
  steps,
  searchQuery,
  className,
}: {
  steps: ReportStep[];
  searchQuery: string;
  className?: string;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return steps;
    return steps.filter(
      (s) =>
        s.instruction.toLowerCase().includes(q) ||
        (s.error && s.error.toLowerCase().includes(q))
    );
  }, [steps, searchQuery]);

  return (
    <div className={cn("space-y-1.5", className)}>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          {searchQuery.trim() ? "No steps match your search." : "No steps in this run."}
        </p>
      ) : (
        filtered.map((step) => (
          <TimelineRow
            key={step.stepId}
            step={step}
            isExpanded={expandedId === step.stepId}
            onToggle={() =>
              setExpandedId((id) => (id === step.stepId ? null : step.stepId))
            }
          />
        ))
      )}
    </div>
  );
}
