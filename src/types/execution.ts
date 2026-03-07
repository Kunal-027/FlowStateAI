/**
 * FlowState AI — Execution & test state types.
 * Supports: Queue → Parsing → Cloud Execution → Self-Healing Verification → Final Report.
 */

// ─── Step-level status (granular) ─────────────────────────────────────────────
export type StepStatus =
  | "idle"
  | "queued"
  | "parsing"
  | "running"
  | "healing"   // self-healing in progress
  | "retrying"  // exponential backoff retry
  | "success"
  | "failed"
  | "skipped";

// ─── Browser channel (for cloud Playwright) ────────────────────────────────────
export type BrowserChannel = "chromium" | "firefox" | "webkit";

// ─── Test case status (aggregate) ────────────────────────────────────────────
export type TestCaseStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled";

// ─── Single test step (e.g. "Click Submit") ───────────────────────────────────
export interface TestStep {
  id: string;
  /** Human-readable instruction (e.g. "Click Submit") */
  instruction: string;
  /** Parsed Playwright-friendly command payload */
  payload: PlaywrightStepPayload | null;
  status: StepStatus;
  /** 0-based execution order */
  order: number;
  /** Last error message if failed */
  error?: string;
  /** Self-healing attempts made for this step */
  healingAttempts: number;
  /** Retry count (for exponential backoff) */
  retryCount: number;
  /** Timestamps for reporting */
  startedAt?: string;
  completedAt?: string;
}

// ─── Playwright command payload (cloud execution) ─────────────────────────────
export interface PlaywrightStepPayload {
  action: "click" | "fill" | "navigate" | "assert" | "select" | "hover" | "wait";
  selector?: string;
  text?: string;
  url?: string;
  value?: string;
  options?: Record<string, unknown>;
}

// ─── Test case (collection of steps) ─────────────────────────────────────────
export interface TestCase {
  id: string;
  name: string;
  steps: TestStep[];
  status: TestCaseStatus;
  /** When execution started */
  startedAt?: string;
  /** When execution finished (success or failed) */
  completedAt?: string;
  /** Aggregate error if failed */
  error?: string;
}

// ─── Execution pipeline phase ────────────────────────────────────────────────
export type ExecutionPhase =
  | "idle"
  | "queue"
  | "parsing"
  | "cloud_execution"
  | "self_healing_verification"
  | "final_report";

// ─── Console / log entry (for Monitor overlay) ────────────────────────────────
export interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "healing" | "retry";
  message: string;
  stepId?: string;
  testCaseId?: string;
  meta?: Record<string, unknown>;
}

// ─── WebSocket frame (for Canvas streaming) ─────────────────────────────────
export interface StreamFrame {
  type: "frame";
  sessionId: string;
  /** Base64-encoded image or raw buffer reference */
  data: string;
  width: number;
  height: number;
  timestamp: number;
}
