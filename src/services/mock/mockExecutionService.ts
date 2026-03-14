import type { LogEntry, TestStep, PlaywrightStepPayload } from "@/types/execution";

/** Actions required by the mock execution service to update store (logs, test case status, active step). */
export interface MockExecutionActions {
  addLog: (entry: Omit<LogEntry, "id" | "timestamp">) => void;
  updateTestCase: (id: string, updates: { status: string; completedAt?: string; error?: string }) => void;
  /** Set the currently running step id (null when idle or between steps). Used to sync sidebar and monitor. */
  setActiveStep?: (id: string | null) => void;
  /** Update a step's status (and optional error/screenshot for reporting). */
  updateStep?: (testCaseId: string, stepId: string, updates: Partial<Pick<TestStep, "status" | "error" | "screenshot" | "expectedElement" | "actualPageContent" | "healingAttempts" | "visualClick" | "discoveryReason" | "validationPassed" | "resolvedBy" | "cacheHit" | "aiHeal" | "failureType">>) => void;
}

/** Result of executing a step via the bridge (step_done / error / ambiguity_error). */
export interface StepResult {
  success: boolean;
  error?: string;
  screenshot?: string;
  selfHealed?: boolean;
  /** True when step succeeded via AI Visual Discovery. */
  visualClick?: boolean;
  /** AI reason (for Visual Discovery hit-rate monitoring). */
  discoveryReason?: string;
  /** True when post-click validation passed (e.g. URL changed). */
  validationPassed?: boolean;
  /** Which resolved this step: interpreter, huggingface, claude, visual_discovery. */
  resolvedBy?: "interpreter" | "huggingface" | "claude" | "visual_discovery";
  expectedElement?: string;
  actualPageContent?: string;
  /** True when step succeeded using Success Map cached selector (no AI). */
  cacheHit?: boolean;
  /** True when step succeeded after semantic discovery healed a failed cached selector. */
  aiHeal?: boolean;
  /** 'selector' = element not found (fixable via AI); 'functional' = verify failed / real bug */
  failureType?: "selector" | "functional";
}

/** Bridge step message: action + optional target (fuzzy-resolved), value, url, etc. */
export interface StepMessage {
  action: string;
  target?: string;
  value?: string;
  key?: string;
  url?: string;
}

/**
 * Converts a TestStep to a bridge step message (action + target for dynamic finder).
 * Uses payload.action and derives target from payload.text or instruction for fuzzy search.
 */
export function toStepMessage(step: TestStep): StepMessage {
  const p = step.payload;
  if (!p) {
    const enterMatch = step.instruction.match(/^enter\s+(.+?)\s+in\s+(.+)$/i) || step.instruction.match(/^type\s+(.+?)\s+in\s+(.+)$/i);
    if (enterMatch) {
      const value = enterMatch[1].trim();
      const field = enterMatch[2].trim().replace(/\s+field$/i, "").trim() || enterMatch[2].trim();
      return { action: "fill", target: field, value };
    }
    return { action: "click", target: step.instruction };
  }
  if (p.action === "navigate" && p.url) {
    return { action: "navigate", url: p.url };
  }
  if (p.action === "fill") {
    const withMatch = step.instruction.match(/fill\s+(.+?)\s+with/i);
    const target = withMatch?.[1]?.trim() ?? p.text ?? "search";
    return { action: "fill", target, value: p.value ?? "" };
  }
  if (p.action === "click" || p.action === "hover") {
    const target = p.text ?? (step.instruction.replace(/^click\s+/i, "").replace(/^hover\s+/i, "").trim() || step.instruction);
    return { action: p.action, target };
  }
  if (p.action === "wait") {
    const ms =
      typeof p.value === "number"
        ? p.value
        : typeof (p.options as { timeout?: number } | undefined)?.timeout === "number"
          ? (p.options as { timeout: number }).timeout
          : parseWaitMs(step.instruction);
    return { action: "wait", value: Math.max(100, ms) };
  }
  const target = p.text ?? step.instruction;
  return { action: p.action, target, value: p.value };
}

/** Parse "wait 5 seconds" / "wait for 5 seconds" / "wait 2s" etc. into milliseconds. */
function parseWaitMs(instruction: string): number {
  const match = instruction.match(/wait\s+(?:for\s+)?(\d+)\s*(s|sec|second|seconds)?/i);
  if (match) {
    const num = parseInt(match[1], 10);
    const inSeconds = !!match[2] || /second|sec|s\b/i.test(instruction);
    return Math.max(100, inSeconds ? num * 1000 : num);
  }
  return 1000;
}

/** Log messages pushed every 2 seconds during mock run (Google flow). */
const MOCK_LOG_MESSAGES = [
  "Navigating to Google...",
  "Typing search query...",
  "Submitting...",
];

const LOG_INTERVAL_MS = 2000;
const COMPLETE_AFTER_MS = 6000;
/** Wait for the stream to connect before deciding active vs mock (bridge opens WS when test starts). */
const CONNECT_WAIT_MS = 4000;

const SEARCH_SELECTOR = 'input[name="q"]';
const SEARCH_VALUE = "test case automation";

/** Options for dynamic execution (bridge + step-by-step). */
export interface MockExecutionOptions {
  getBridgeSend?: () => ((msg: object) => void) | null;
  getExecuteStep?: () => ((stepMsg: StepMessage) => Promise<StepResult>) | null;
  getSessionId?: () => string | null;
  /** Delay in ms after each step (so user can see where it clicked). 0–5000. */
  getStepDelayMs?: () => number;
  /** If provided, awaited before each step; use to implement Pause (return pending promise when paused). */
  getWaitIfPaused?: () => Promise<void>;
  /** Called when a run finishes (success or failed). Use to persist a report from the store. */
  onRunComplete?: (testCaseId: string) => void;
  steps?: TestStep[];
}

/**
 * Starts execution for the given test case.
 * - When getExecuteStep and steps are provided: runs dynamic steps (action + target); bridge resolves target (AI or fuzzy finder).
 * - Else when getBridgeSend is available: runs hardcoded Google flow (fill + press) with 1s delays.
 * - Otherwise: single "Bridge not connected" log and marks test complete after 1.5s.
 * @param testCaseId - Id of the test case being run.
 * @param actions - Callbacks to addLog and updateTestCase (and optionally notify the bridge).
 * @param options - Optional getBridgeSend, getExecuteStep, getSessionId, and steps.
 * @returns Cleanup function that cancels timers; call on unmount or when starting a new run.
 */
export function startMockExecution(
  testCaseId: string,
  actions: MockExecutionActions,
  options?: MockExecutionOptions
): () => void {
  const getBridgeSend = options?.getBridgeSend;
  const getExecuteStep = options?.getExecuteStep;
  const getSessionId = options?.getSessionId;
  const getStepDelayMs = options?.getStepDelayMs;
  const getWaitIfPaused = options?.getWaitIfPaused;
  const onRunComplete = options?.onRunComplete;
  const steps = options?.steps ?? [];

  /** Sends test_finished or test_failed to the bridge when a run completes, if bridge is connected. */
  function notifyTestEnd(success: boolean) {
    const send = getBridgeSend?.();
    const sessionId = getSessionId?.() ?? undefined;
    if (send && sessionId) send({ type: success ? "test_finished" : "test_failed", sessionId });
  }

  let cancelled = false;
  const timeouts: ReturnType<typeof setTimeout>[] = [];
  let mockInterval: ReturnType<typeof setInterval> | null = null;
  let mockTimeout: ReturnType<typeof setTimeout> | null = null;
  const delay = (ms: number) =>
    new Promise<void>((resolve) => {
      const id = setTimeout(() => {
        if (!cancelled) resolve();
      }, ms);
      timeouts.push(id);
    });

  (async () => {
    try {
    /** When we have steps, wait for the bridge to connect; then run real steps. Console logs come ONLY from the bridge. */
    if (steps.length > 0) {
      await delay(CONNECT_WAIT_MS);
      if (cancelled) return;
      const executeStep = getExecuteStep?.();
      if (executeStep) {
        const sortedSteps = [...steps].sort((a, b) => a.order - b.order);
        const setActiveStep = actions.setActiveStep;
        const updateStep = actions.updateStep;
        for (let i = 0; i < sortedSteps.length; i++) {
          if (cancelled) return;
          await getWaitIfPaused?.();
          if (cancelled) return;
          const step = sortedSteps[i];
          setActiveStep?.(step.id);
          updateStep?.(testCaseId, step.id, { status: "running" });
          const stepMsg = { ...toStepMessage(step), instruction: step.instruction };
          try {
            const result = await executeStep(stepMsg);
            if (cancelled) return;
            updateStep?.(testCaseId, step.id, {
              status: result.success ? "success" : "failed",
              ...(result.success ? {} : { error: result.error }),
              screenshot: result.screenshot,
              ...(result.expectedElement != null ? { expectedElement: result.expectedElement } : {}),
              ...(result.actualPageContent != null ? { actualPageContent: result.actualPageContent } : {}),
              ...(result.selfHealed ? { healingAttempts: 1 } : {}),
              ...(result.visualClick ? { visualClick: true } : {}),
              ...(result.discoveryReason != null ? { discoveryReason: result.discoveryReason } : {}),
              ...(result.validationPassed != null ? { validationPassed: result.validationPassed } : {}),
              ...(result.resolvedBy != null ? { resolvedBy: result.resolvedBy } : {}),
              ...(result.cacheHit ? { cacheHit: true } : {}),
              ...(result.aiHeal ? { aiHeal: true } : {}),
              ...(result.failureType != null ? { failureType: result.failureType } : {}),
            });
            if (!result.success) {
              const errorWithStep = step.instruction ? `${step.instruction}: ${result.error ?? "Step failed."}` : (result.error ?? "Step failed.");
              actions.updateTestCase(testCaseId, { status: "failed", error: errorWithStep, completedAt: new Date().toISOString() });
              setActiveStep?.(null);
              onRunComplete?.(testCaseId);
              notifyTestEnd(false);
              return;
            }
            // Apply step delay after EVERY step (including last) so delay is visible and pause works before completion
            const stepDelayMs = Math.max(0, Math.min(5000, getStepDelayMs?.() ?? 1000));
            if (stepDelayMs > 0) {
              await delay(stepDelayMs);
              if (cancelled) return;
              await getWaitIfPaused?.();
              if (cancelled) return;
            }
          } catch (err) {
            if (cancelled) return;
            const res = err && typeof err === "object" && "error" in err ? (err as StepResult) : null;
            const message = res ? String(res.error) : String(err);
            const errorWithStep = step.instruction ? `${step.instruction}: ${message}` : message;
            updateStep?.(testCaseId, step.id, {
              status: "failed",
              error: message,
              ...(res?.screenshot ? { screenshot: res.screenshot } : {}),
              ...(res?.expectedElement != null ? { expectedElement: res.expectedElement } : {}),
              ...(res?.actualPageContent != null ? { actualPageContent: res.actualPageContent } : {}),
              ...(res?.resolvedBy != null ? { resolvedBy: res.resolvedBy } : {}),
              ...(res?.failureType != null ? { failureType: res.failureType } : {}),
            });
            actions.updateTestCase(testCaseId, { status: "failed", error: errorWithStep, completedAt: new Date().toISOString() });
            setActiveStep?.(null);
            onRunComplete?.(testCaseId);
            notifyTestEnd(false);
            return;
          }
        }
        // Pause check after last step so user can pause before we mark complete
        await getWaitIfPaused?.();
        if (cancelled) return;
        setActiveStep?.(null);
        actions.updateTestCase(testCaseId, { status: "success", completedAt: new Date().toISOString() });
        onRunComplete?.(testCaseId);
        notifyTestEnd(true);
        actions.addLog({ level: "info", message: `All ${sortedSteps.length} step(s) completed successfully.`, testCaseId });
        return;
      }
    }

    /** No bridge: single log only; no fake step-by-step logs. */
    if (steps.length > 0) {
      actions.addLog({
        level: "info",
        message: "Bridge not connected. Start the bridge (port 4000) to run tests in the browser.",
        testCaseId,
      });
      mockTimeout = setTimeout(() => {
        actions.updateTestCase(testCaseId, { status: "success", completedAt: new Date().toISOString() });
        onRunComplete?.(testCaseId);
        notifyTestEnd(true);
      }, 1500);
    } else {
      actions.addLog({
        level: "info",
        message: "Bridge not connected. Start the bridge (port 4000) to run tests.",
        testCaseId,
      });
      mockTimeout = setTimeout(() => {
        actions.updateTestCase(testCaseId, { status: "success", completedAt: new Date().toISOString() });
        onRunComplete?.(testCaseId);
        notifyTestEnd(true);
      }, 1500);
    }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        actions.updateTestCase(testCaseId, { status: "failed", error: msg, completedAt: new Date().toISOString() });
      } catch (_) {}
      notifyTestEnd(false);
    }
  })();

  return function cleanup() {
    cancelled = true;
    timeouts.forEach(clearTimeout);
    if (mockInterval) clearInterval(mockInterval);
    if (mockTimeout) clearTimeout(mockTimeout);
  };
}
