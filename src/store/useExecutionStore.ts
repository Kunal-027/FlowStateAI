import { create } from "zustand";
import type {
  TestCase,
  TestStep,
  LogEntry,
  ExecutionPhase,
  TestCaseStatus,
  BrowserChannel,
} from "@/types/execution";
import { parseSingleInstruction } from "@/lib/parser";

// ─── State shape ─────────────────────────────────────────────────────────────
export interface ExecutionState {
  phase: ExecutionPhase;
  testCases: TestCase[];
  /** Currently active test case id (running) */
  activeTestCaseId: string | null;
  /** Currently active step id (running / healing / retrying) */
  activeStepId: string | null;
  logs: LogEntry[];
  /** WebSocket session id when stream is connected */
  streamSessionId: string | null;
  /** Connection state for remote browser stream */
  streamConnected: boolean;
  /** Latest frame buffer (base64) for Canvas */
  lastFrameData: string | null;
  lastFrameWidth: number;
  lastFrameHeight: number;
  /** Browser to use for remote Playwright execution (chromium, firefox, webkit). */
  selectedBrowser: BrowserChannel;
  /** Delay in ms after each step so user can see where it clicked (0–5000). */
  stepDelayMs: number;
  /** Send a message to the bridge (set when stream connects, cleared on disconnect). */
  bridgeSend: ((msg: object) => void) | null;
  /** Execute a step and wait for result (resolves on step_done, rejects on error/ambiguity_error). */
  executeStep: ((stepMsg: object) => Promise<{
    success: boolean;
    error?: string;
    screenshot?: string;
    resolvedBy?: "interpreter" | "huggingface" | "claude" | "visual_discovery";
  }>) | null;
}

// ─── Actions ─────────────────────────────────────────────────────────────────
export interface ExecutionActions {
  setPhase: (phase: ExecutionPhase) => void;
  setTestCases: (cases: TestCase[]) => void;
  addTestCase: (testCase: TestCase) => void;
  updateTestCase: (id: string, updates: Partial<TestCase>) => void;
  updateStep: (
    testCaseId: string,
    stepId: string,
    updates: Partial<TestStep>
  ) => void;
  addStep: (testCaseId: string, instruction?: string) => void;
  deleteStep: (testCaseId: string, stepId: string) => void;
  setActiveTestCase: (id: string | null) => void;
  setActiveStep: (id: string | null) => void;
  addLog: (entry: Omit<LogEntry, "id" | "timestamp">) => void;
  clearLogs: () => void;
  setStreamSession: (sessionId: string | null) => void;
  setStreamConnected: (connected: boolean) => void;
  /** Push a new frame from WebSocket (updates lastFrameData and dimensions) */
  pushFrame: (data: string, width: number, height: number) => void;
  /** Sets the browser channel for cloud execution (chromium, firefox, webkit). */
  setSelectedBrowser: (browser: BrowserChannel) => void;
  /** Sets the delay in ms after each step (0–5000). */
  setStepDelayMs: (ms: number) => void;
  /** Register/unregister the bridge send function (used by BrowserCanvas). */
  setBridgeSend: (fn: ((msg: object) => void) | null) => void;
  /** Register/unregister executeStep (used by BrowserCanvas when stream connects). */
  setExecuteStep: (fn: ((stepMsg: object) => Promise<{
    success: boolean;
    error?: string;
    screenshot?: string;
    resolvedBy?: "interpreter" | "huggingface" | "claude" | "visual_discovery";
  }>) | null) => void;
  /** Reset store to initial state */
  reset: () => void;
}

const initialPhase: ExecutionPhase = "idle";
const initialTestCases: TestCase[] = [];
const initialLogs: LogEntry[] = [];

const defaultState: ExecutionState = {
  phase: initialPhase,
  testCases: initialTestCases,
  activeTestCaseId: null,
  activeStepId: null,
  logs: initialLogs,
  streamSessionId: null,
  streamConnected: false,
  lastFrameData: null,
  lastFrameWidth: 1280,
  lastFrameHeight: 720,
  selectedBrowser: "chromium",
  stepDelayMs: 1000,
  bridgeSend: null,
  executeStep: null,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Generates a unique id from timestamp and random string (for log entries, etc.). */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

const store = create<ExecutionState & ExecutionActions>(
  (set) => ({
    ...defaultState,

    /** Sets the current execution pipeline phase (idle, queue, parsing, cloud_execution, etc.). */
    setPhase: (phase) => set({ phase }),

    /** Replaces the entire test cases list. */
    setTestCases: (testCases) => set({ testCases }),

    /** Appends one test case to the list. */
    addTestCase: (testCase) =>
      set((state) => ({
        testCases: [...state.testCases, testCase],
      })),

    /** Updates a test case by id with partial fields (e.g. status, completedAt). */
    updateTestCase: (id, updates) =>
      set((state) => ({
        testCases: state.testCases.map((tc) =>
          tc.id === id ? { ...tc, ...updates } : tc
        ),
      })),

    /** Updates a single step within a test case by testCaseId and stepId. */
    updateStep: (testCaseId, stepId, updates) =>
      set((state) => ({
        testCases: state.testCases.map((tc) => {
          if (tc.id !== testCaseId) return tc;
          return {
            ...tc,
            steps: tc.steps.map((s) =>
              s.id === stepId ? { ...s, ...updates } : s
            ),
          };
        }),
      })),

    /** Appends a new step to a test case. Optional instruction; default placeholder. */
    addStep: (testCaseId, instruction = "") =>
      set((state) => {
        const newStep: TestStep = {
          id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
          instruction,
          payload: parseSingleInstruction(instruction),
          status: "idle",
          order: 0,
          healingAttempts: 0,
          retryCount: 0,
        };
        return {
          testCases: state.testCases.map((tc) => {
            if (tc.id !== testCaseId) return tc;
            const steps = [...tc.steps, { ...newStep, order: tc.steps.length }];
            return { ...tc, steps };
          }),
        };
      }),

    /** Removes a step and renumbers remaining steps by order. */
    deleteStep: (testCaseId, stepId) =>
      set((state) => ({
        testCases: state.testCases.map((tc) => {
          if (tc.id !== testCaseId) return tc;
          const steps = tc.steps
            .filter((s) => s.id !== stepId)
            .map((s, i) => ({ ...s, order: i }));
          return { ...tc, steps };
        }),
      })),

    /** Sets the currently selected/running test case id (or null). */
    setActiveTestCase: (activeTestCaseId) => set({ activeTestCaseId }),
    /** Sets the currently running/healing/retrying step id (or null). */
    setActiveStep: (activeStepId) => set({ activeStepId }),

    /** Appends a log entry with auto-generated id and timestamp. */
    addLog: (entry) =>
      set((state) => ({
        logs: [
          ...state.logs,
          {
            ...entry,
            id: generateId(),
            timestamp: new Date().toISOString(),
          },
        ],
      })),

    /** Clears all console log entries. */
    clearLogs: () => set({ logs: [] }),

    /** Sets the WebSocket stream session id when a session starts or ends. */
    setStreamSession: (streamSessionId) => set({ streamSessionId }),
    /** Sets whether the stream WebSocket is connected. */
    setStreamConnected: (streamConnected) => set({ streamConnected }),

    /** Stores the latest frame from the stream for the Canvas (base64 data + dimensions). */
    pushFrame: (data, width, height) =>
      set({ lastFrameData: data, lastFrameWidth: width, lastFrameHeight: height }),

    /** Sets the browser channel for cloud execution (chromium, firefox, webkit). */
    setSelectedBrowser: (selectedBrowser) => set({ selectedBrowser }),

    /** Sets the delay in ms after each step (0–5000). */
    setStepDelayMs: (stepDelayMs) => set({ stepDelayMs: Math.max(0, Math.min(5000, stepDelayMs)) }),

    /** Register/unregister the bridge send function (used by BrowserCanvas when stream connects). */
    setBridgeSend: (bridgeSend) => set({ bridgeSend }),

    /** Register/unregister executeStep (used by BrowserCanvas when stream connects). */
    setExecuteStep: (executeStep) => set({ executeStep }),

    /** Resets the store to initial state (phase, test cases, logs, stream, etc.). */
    reset: () => set(defaultState),
  })
);

/** Hook for components (useExecutionStore). */
export const useExecutionStore = store;

/** Get current execution state outside React (e.g. in event handlers). Use this instead of useExecutionStore.getState() to avoid "getState is not a function" in some environments. */
export function getExecutionState(): ExecutionState & ExecutionActions {
  return store.getState();
}

// ─── Selectors (convenience) ─────────────────────────────────────────────────
/** Returns a selector that filters test cases by the given status. */
export function getCasesByStatus(status: TestCaseStatus): (state: ExecutionState) => TestCase[] {
  return (state) => state.testCases.filter((tc) => tc.status === status);
}

/** Returns all test cases with status "queued". */
export function getQueuedCases(state: ExecutionState): TestCase[] {
  return state.testCases.filter((tc) => tc.status === "queued");
}
/** Returns all test cases with status "running". */
export function getRunningCases(state: ExecutionState): TestCase[] {
  return state.testCases.filter((tc) => tc.status === "running");
}
/** Returns all test cases with status "success". */
export function getSuccessCases(state: ExecutionState): TestCase[] {
  return state.testCases.filter((tc) => tc.status === "success");
}
/** Returns all test cases with status "failed". */
export function getFailedCases(state: ExecutionState): TestCase[] {
  return state.testCases.filter((tc) => tc.status === "failed");
}
