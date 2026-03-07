import type { PlaywrightStepPayload } from "@/types/execution";

/**
 * Result of a single self-healing attempt.
 * The heuristic may suggest a new selector, coordinates, or give up.
 */
export interface SelfHealingResult {
  recovered: boolean;
  /** New payload to try (e.g. with alternative selector or coordinates) */
  payload?: PlaywrightStepPayload;
  /** Human-readable reason (e.g. "Fuzzy match on button text") */
  reason?: string;
}

/**
 * Context passed to the self-healing heuristic (e.g. for future AI: page HTML, screenshot, error).
 */
export interface SelfHealingContext {
  /** Original instruction text (e.g. "Click Submit") */
  instruction: string;
  /** Payload that failed */
  failedPayload: PlaywrightStepPayload;
  /** Error message from the failed attempt */
  errorMessage: string;
  /** Optional: serialized DOM or snapshot for AI heuristics */
  pageContext?: string;
  /** Optional: base64 screenshot for visual fallback */
  screenshot?: string;
}

/**
 * Self-healing strategy interface.
 * Implementations: fuzzy-match + visual fallback (default), or swap for AI-based heuristic.
 */
export interface ISelfHealingHeuristic {
  /**
   * Attempt to recover from a failed step. Returns a new payload to retry, or recovered: false.
   */
  attemptRecovery(context: SelfHealingContext): Promise<SelfHealingResult>;
}
