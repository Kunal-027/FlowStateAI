import type { PlaywrightStepPayload } from "@/types/execution";

/**
 * Service layer for cloud Playwright execution.
 * No local browser code runs; all execution happens in remote containers.
 *
 * Implement this by calling your backend API that talks to Playwright workers
 * (e.g. POST /api/run-step with payload, returns { success, error?, pageContext? }).
 */
export interface CloudExecutionResult {
  success: boolean;
  error?: string;
  /** Optional serialized DOM or snapshot for self-healing context */
  pageContext?: string;
}

export interface ICloudExecutionService {
  /**
   * Execute a single Playwright step in the cloud. Returns result for self-healing/retry logic.
   */
  runStep(
    sessionId: string,
    payload: PlaywrightStepPayload
  ): Promise<CloudExecutionResult>;
}

/**
 * Placeholder implementation. Replace with real HTTP/WebSocket call to your
 * Playwright container orchestration (e.g. Kubernetes jobs, Lambda, or dedicated API).
 */
export class CloudExecutionService implements ICloudExecutionService {
  /** baseUrl defaults to NEXT_PUBLIC_EXECUTION_API or "/api". */
  constructor(
    private baseUrl: string = process.env.NEXT_PUBLIC_EXECUTION_API ?? "/api"
  ) {}

  /** POSTs the step to /run-step and returns success, error, and optional pageContext for self-healing. */
  async runStep(
    sessionId: string,
    payload: PlaywrightStepPayload
  ): Promise<CloudExecutionResult> {
    const res = await fetch(`${this.baseUrl}/run-step`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        success: false,
        error: data.error ?? `HTTP ${res.status}`,
        pageContext: data.pageContext,
      };
    }
    return {
      success: data.success ?? false,
      error: data.error,
      pageContext: data.pageContext,
    };
  }
}

export const cloudExecutionService = new CloudExecutionService();
