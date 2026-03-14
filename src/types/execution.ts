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
  /** Base64 screenshot when step failed (e.g. from bridge ambiguity_error). */
  screenshot?: string;
  /** For failed steps: what we tried to find (e.g. instruction). Used in HTML report. */
  expectedElement?: string;
  /** For failed steps: sanitized page snippet when step failed. Used in HTML report. */
  actualPageContent?: string;
  /** Self-healing attempts made for this step */
  healingAttempts: number;
  /** Retry count (for exponential backoff) */
  retryCount: number;
  /** True if step succeeded via visual fallback (AI Visual Discovery). */
  visualClick?: boolean;
  /** AI reason when visual discovery was used (for hit-rate monitoring). */
  discoveryReason?: string;
  /** True when post-click validation passed (e.g. URL changed). */
  validationPassed?: boolean;
  /** Which resolved this step: interpreter, huggingface, claude, or visual_discovery. */
  resolvedBy?: "interpreter" | "huggingface" | "claude" | "visual_discovery";
  /** True when step succeeded using Success Map cached selector (no AI). */
  cacheHit?: boolean;
  /** True when step succeeded after semantic discovery healed a failed cached selector. */
  aiHeal?: boolean;
  /** For failed steps: 'selector' = element not found (fixable via AI); 'functional' = verify failed / real bug */
  failureType?: "selector" | "functional";
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

// ─── Run report (for Reports tab & HTML export) ──────────────────────────────
/** Single step entry in a run report (snapshot at completion). */
export interface ReportStep {
  stepId: string;
  order: number;
  instruction: string;
  status: StepStatus;
  /** Error message when status is failed. */
  error?: string;
  /** Base64 screenshot when step failed. */
  screenshot?: string;
  /** True if self-healing was used for this step (show purple badge). */
  selfHealed: boolean;
  /** True if step succeeded via visual fallback (AI Visual Discovery). */
  visualClick?: boolean;
  /** AI reason when Visual Discovery was used (for hit-rate monitoring). */
  discoveryReason?: string;
  /** True when post-click validation passed (e.g. URL changed). */
  validationPassed?: boolean;
  /** Which resolved this step: interpreter, huggingface, claude, or visual_discovery. */
  resolvedBy?: "interpreter" | "huggingface" | "claude" | "visual_discovery";
  /** True when step succeeded using Success Map cached selector (no AI). */
  cacheHit?: boolean;
  /** True when step succeeded after semantic discovery healed a failed cached selector. */
  aiHeal?: boolean;
  /** For failed steps: 'selector' = element not found (fixable via AI); 'functional' = verify failed / real bug. */
  failureType?: "selector" | "functional";
  /** For failed steps: expected element (e.g. instruction) for HTML report. */
  expectedElement?: string;
  /** For failed steps: actual page content snippet for HTML report. */
  actualPageContent?: string;
  startedAt?: string;
  completedAt?: string;
}

/** One completed run report (persisted for Reports tab and export). */
export interface RunReport {
  id: string;
  testCaseId: string;
  testCaseName: string;
  status: TestCaseStatus;
  startedAt: string;
  completedAt: string;
  /** Aggregate error when status is failed. */
  error?: string;
  steps: ReportStep[];
}
