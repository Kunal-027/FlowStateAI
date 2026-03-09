import type { TestStep, PlaywrightStepPayload } from "@/types/execution";
import type { ISelfHealingHeuristic } from "@/lib/self-healing";
import { defaultHeuristic } from "@/lib/self-healing";

const MAX_HEALING_ATTEMPTS = 2;
const MAX_RETRIES_NETWORK = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Exponential backoff delay for retry index i: BASE * 2^i
 */
export function getBackoffMs(retryIndex: number): number {
  return BASE_BACKOFF_MS * Math.pow(2, retryIndex);
}

/**
 * Parses a JSON instruction set into TestSteps with Playwright payloads.
 * Does not execute; only builds the step list.
 */
export function parseInstructionsToSteps(
  instructions: Array<{ id?: string; instruction: string; order?: number }>
): TestStep[] {
  return instructions.map((item, index) => {
    const order = item.order ?? index;
    const payload = parseSingleInstruction(item.instruction);
    return {
      id: item.id ?? `step-${Date.now()}-${index}`,
      instruction: item.instruction,
      payload,
      status: "idle",
      order,
      healingAttempts: 0,
      retryCount: 0,
    };
  });
}

/** Common typos so parsed target matches DOM text (e.g. "Companies" in the UI). */
const COMMON_TYPO_CORRECTIONS: Record<string, string> = {
  comapnies: "companies",
  compaines: "companies",
  companys: "companies",
  settigns: "settings",
  setings: "settings",
  dashbord: "dashboard",
  dashborad: "dashboard",
  logn: "login",
  sigin: "sign in",
  sigout: "sign out",
  serach: "search",
  serch: "search",
};

/**
 * Extracts the click/hover target from the remainder after the verb.
 * e.g. "on 'Companies' Menu" → "Companies Menu", "Login" → "Login".
 */
function extractClickTarget(rest: string): string {
  const s = rest.trim();
  const quoted = s.match(/^(?:on\s+)?["']([^"']+)["']\s*(.*)$/i);
  if (quoted) {
    const part = quoted[1].trim();
    const trail = (quoted[2] ?? "").trim();
    return trail ? `${part} ${trail}` : part;
  }
  return s.replace(/^on\s+/i, "").trim() || s;
}

function applyTypoCorrection(phrase: string): string {
  if (!phrase.trim()) return phrase;
  return phrase
    .trim()
    .split(/\s+/)
    .map((w) => COMMON_TYPO_CORRECTIONS[w.toLowerCase()] ?? w)
    .join(" ");
}

/**
 * Parses one instruction string (e.g. "Click Submit", "fill email with x@y.com") into a Playwright payload.
 * Supports: click, fill, navigate, assert, select, hover, wait. Returns null if unrecognized.
 * Parses targets well (e.g. "Click on 'Companies' Menu" → text: "Companies Menu") so the bridge has a clear target.
 */
export function parseSingleInstruction(instruction: string): PlaywrightStepPayload | null {
  const lower = instruction.trim().toLowerCase();
  /** "Select X from Y" → dropdown; "Select X" / "Click on X" → click */
  if (lower.startsWith("select ") && lower.includes(" from ")) {
    const match = instruction.match(/select\s+(.+?)\s+from\s+(.+)/i);
    const value = match?.[1]?.trim();
    const label = match?.[2]?.trim();
    return {
      action: "select",
      selector: label ? `select:has(option:has-text("${label}"))` : "select",
      value: value ?? undefined,
    };
  }
  if (lower.startsWith("click ") || lower.startsWith("select ") || lower.startsWith("press ") || lower.startsWith("tap ")) {
    const rest = instruction.replace(/^(?:click|select|press|tap)\s+(?:on\s+)?/i, "").trim();
    const raw = extractClickTarget(rest);
    const text = applyTypoCorrection(raw);
    return {
      action: "click",
      selector: `button:has-text("${text}"), a:has-text("${text}"), [role="button"]:has-text("${text}")`,
      text,
    };
  }
  if (lower.startsWith("fill ") && lower.includes(" with ")) {
    const [fieldPart, valuePart] = instruction.split(/\s+with\s+/i);
    const field = fieldPart.replace(/^fill\s+/i, "").trim();
    const value = valuePart?.trim() ?? "";
    return {
      action: "fill",
      selector: `input[name="${field}"], input[placeholder="${field}"], label:has-text("${field}")`,
      value,
    };
  }
  /** "Enter X in Y field" / "Type X in Y" → fill action (value X, target/field Y). */
  if (lower.startsWith("enter ") && lower.includes(" in ")) {
    const enterMatch = instruction.match(/^enter\s+(.+?)\s+in\s+(.+)$/i);
    if (enterMatch) {
      const value = enterMatch[1].trim();
      const field = enterMatch[2].trim().replace(/\s+field$/i, "").trim() || enterMatch[2].trim();
      return {
        action: "fill",
        selector: `input[name="${field}"], input[placeholder="${field}"], input[type="text"], input[type="email"]`,
        text: field,
        value,
      };
    }
  }
  if (lower.startsWith("type ") && lower.includes(" in ")) {
    const typeMatch = instruction.match(/^type\s+(.+?)\s+in\s+(.+)$/i);
    if (typeMatch) {
      const value = typeMatch[1].trim();
      const field = typeMatch[2].trim().replace(/\s+field$/i, "").trim() || typeMatch[2].trim();
      return {
        action: "fill",
        selector: `input[name="${field}"], input[placeholder="${field}"], input[type="text"], input[type="email"]`,
        text: field,
        value,
      };
    }
  }
  if (lower.startsWith("navigate ") || lower.startsWith("go to ")) {
    const url = instruction.replace(/^(navigate|go to)\s+/i, "").trim();
    return { action: "navigate", url };
  }
  if (lower.startsWith("assert ") || lower.startsWith("check ")) {
    const text = instruction.replace(/^(assert|check)\s+/i, "").trim();
    return {
      action: "assert",
      selector: `text=${text}`,
      text,
    };
  }
  if (lower.startsWith("hover ")) {
    const rest = instruction.replace(/^hover\s+(?:on\s+)?/i, "").trim();
    const raw = extractClickTarget(rest);
    const text = applyTypoCorrection(raw);
    return {
      action: "hover",
      selector: `text=${text}`,
      text,
    };
  }
  if (lower.startsWith("wait ")) {
    const duration = instruction.replace(/^wait\s+/i, "").trim();
    const numMatch = duration.match(/\d+/);
    const num = numMatch ? parseInt(numMatch[0], 10) : 1;
    const ms = /second|sec|s\b/i.test(duration) ? num * 1000 : Math.max(100, num);
    return { action: "wait", value: ms, options: { timeout: ms } };
  }
  return null;
}

/**
 * Network-bound actions that should use exponential backoff retry.
 */
const NETWORK_ACTIONS = new Set(["navigate", "click", "fill", "select"]);

/** Returns true if the step action is network-bound (navigate, click, fill, select) and should use exponential backoff retry. */
export function isNetworkBound(payload: PlaywrightStepPayload | null): boolean {
  return payload !== null && NETWORK_ACTIONS.has(payload.action);
}

/**
 * Options for executeStepWithHealingAndRetry: step, optional heuristic, runPayload callback, and optional onHealing/onRetry callbacks.
 */
export interface ExecuteStepOptions {
  step: TestStep;
  heuristic?: ISelfHealingHeuristic;
  /** Simulated: actually run the payload via cloud service */
  runPayload: (payload: PlaywrightStepPayload) => Promise<{ success: boolean; error?: string; pageContext?: string }>;
  onHealing?: (attempt: number, reason: string) => void;
  onRetry?: (attempt: number, delayMs: number) => void;
}

/**
 * Executes one step via runPayload; on failure tries the self-healing heuristic (up to MAX_HEALING_ATTEMPTS),
 * then for network-bound steps retries with exponential backoff. Returns Failed only when all recovery and retries are exhausted.
 */
export async function executeStepWithHealingAndRetry({
  step,
  heuristic = defaultHeuristic,
  runPayload,
  onHealing,
  onRetry,
}: ExecuteStepOptions): Promise<{ success: boolean; error?: string }> {
  let currentPayload = step.payload;
  if (!currentPayload) {
    return { success: false, error: "No parsed payload for step" };
  }

  let healingAttempts = step.healingAttempts;
  let retryCount = step.retryCount;
  const isNetwork = isNetworkBound(currentPayload);

  // Retry loop (for network: exponential backoff)
  while (true) {
    const result = await runPayload(currentPayload);
    if (result.success) return { success: true };

    const errorMessage = result.error ?? "Unknown error";

    // 1) Self-healing: try heuristic before giving up
    if (healingAttempts < MAX_HEALING_ATTEMPTS) {
      const recovery = await heuristic.attemptRecovery({
        instruction: step.instruction,
        failedPayload: currentPayload,
        errorMessage,
        pageContext: result.pageContext,
      });
      if (recovery.recovered && recovery.payload) {
        healingAttempts++;
        currentPayload = recovery.payload;
        onHealing?.(healingAttempts, recovery.reason ?? "Recovered");
        continue;
      }
    }

    // 2) Retry with backoff for network-bound steps
    if (isNetwork && retryCount < MAX_RETRIES_NETWORK) {
      const delayMs = getBackoffMs(retryCount);
      onRetry?.(retryCount + 1, delayMs);
      await new Promise((r) => setTimeout(r, delayMs));
      retryCount++;
      continue;
    }

    return { success: false, error: errorMessage };
  }
}
