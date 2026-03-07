import type { LogEntry } from "@/types/execution";
import type { TestStep, PlaywrightStepPayload } from "@/types/execution";

/** Actions required by the mock execution service to update store (logs, test case status, active step). */
export interface MockExecutionActions {
  addLog: (entry: Omit<LogEntry, "id" | "timestamp">) => void;
  updateTestCase: (id: string, updates: { status: string; completedAt?: string; error?: string }) => void;
  /** Set the currently running step id (null when idle or between steps). Used to sync sidebar and monitor. */
  setActiveStep?: (id: string | null) => void;
  /** Update a step's status (e.g. running, success, failed). */
  updateStep?: (testCaseId: string, stepId: string, updates: Partial<{ status: string }>) => void;
}

/** Result of executing a step via the bridge (step_done / error / ambiguity_error). */
export interface StepResult {
  success: boolean;
  error?: string;
  screenshot?: string;
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
            updateStep?.(testCaseId, step.id, { status: result.success ? "success" : "failed" });
            if (!result.success) {
              actions.updateTestCase(testCaseId, { status: "failed", error: result.error, completedAt: new Date().toISOString() });
              setActiveStep?.(null);
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
            const message = err && typeof err === "object" && "error" in err ? String((err as StepResult).error) : String(err);
            updateStep?.(testCaseId, step.id, { status: "failed" });
            actions.updateTestCase(testCaseId, { status: "failed", error: message, completedAt: new Date().toISOString() });
            setActiveStep?.(null);
            notifyTestEnd(false);
            return;
          }
        }
        // Pause check after last step so user can pause before we mark complete
        await getWaitIfPaused?.();
        if (cancelled) return;
        setActiveStep?.(null);
        actions.updateTestCase(testCaseId, { status: "success", completedAt: new Date().toISOString() });
        notifyTestEnd(true);
        actions.addLog({ level: "info", message: `All ${sortedSteps.length} step(s) completed successfully.`, testCaseId });
        return;
      }
    }

    /** No bridge: single log only; no fake step-by-step logs. */
    if (steps.length > 0) {
      actions.addLog({
        level: "info",
        message: "Bridge not connected. Start the bridge (port 4001) to run tests in the browser.",
        testCaseId,
      });
      mockTimeout = setTimeout(() => {
        actions.updateTestCase(testCaseId, { status: "success", completedAt: new Date().toISOString() });
        notifyTestEnd(true);
      }, 1500);
    } else {
      actions.addLog({
        level: "info",
        message: "Bridge not connected. Start the bridge (port 4001) to run tests.",
        testCaseId,
      });
      mockTimeout = setTimeout(() => {
        actions.updateTestCase(testCaseId, { status: "success", completedAt: new Date().toISOString() });
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
