import type { TestCase, TestStep } from "@/types/execution";

const STORAGE_KEY = "flowstate-test-cases";
const STORAGE_KEY_BACKUP = "flowstate-test-cases-backup";

function normalizeStep(s: unknown): TestStep | null {
  const step = s as Record<string, unknown> | null;
  if (!step || typeof step.id !== "string" || typeof step.instruction !== "string") return null;
  return {
    id: step.id,
    instruction: step.instruction,
    payload: (step.payload as TestStep["payload"]) ?? null,
    status: (step.status as TestStep["status"]) ?? "idle",
    order: typeof step.order === "number" ? step.order : 0,
    healingAttempts: typeof step.healingAttempts === "number" ? step.healingAttempts : 0,
    retryCount: typeof step.retryCount === "number" ? step.retryCount : 0,
    ...(step.error !== undefined && { error: String(step.error) }),
    ...(step.screenshot !== undefined && { screenshot: String(step.screenshot) }),
    ...(step.expectedElement !== undefined && { expectedElement: String(step.expectedElement) }),
    ...(step.actualPageContent !== undefined && { actualPageContent: String(step.actualPageContent) }),
    ...(step.visualClick !== undefined && { visualClick: !!step.visualClick }),
    ...(step.discoveryReason !== undefined && { discoveryReason: String(step.discoveryReason) }),
    ...(step.validationPassed !== undefined && { validationPassed: !!step.validationPassed }),
    ...(step.resolvedBy !== undefined && { resolvedBy: step.resolvedBy as TestStep["resolvedBy"] }),
    ...(step.startedAt !== undefined && { startedAt: String(step.startedAt) }),
    ...(step.completedAt !== undefined && { completedAt: String(step.completedAt) }),
  };
}

function parseStoredCases(raw: string | null): TestCase[] | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const cases = parsed.map((item) => {
      const tc = item as Record<string, unknown>;
      if (!tc || typeof tc.id !== "string" || typeof tc.name !== "string" || !Array.isArray(tc.steps))
        return null;
      const steps = (tc.steps as unknown[])
        .map(normalizeStep)
        .filter((step): step is TestStep => step !== null);
      return {
        id: tc.id,
        name: tc.name,
        steps,
        status: "queued" as const,
      } satisfies TestCase;
    });
    const valid = cases.filter((c): c is TestCase => c !== null);
    return valid;
  } catch {
    return null;
  }
}

/**
 * Loads test cases from localStorage.
 * - Returns TestCase[] (maybe empty) if key exists and parsed OK.
 * - Returns null only if key is missing or parse error (so caller can seed mocks).
 * Loaded cases are normalized to status "queued" so we don't restore "running".
 */
export function loadTestCasesFromStorage(): TestCase[] | null {
  if (typeof window === "undefined") return null;
  return parseStoredCases(window.localStorage.getItem(STORAGE_KEY));
}

/**
 * Loads the last saved backup (previous version before current save). Use when tests were overwritten.
 * Returns null if no backup or parse error.
 */
export function loadTestCasesFromBackup(): TestCase[] | null {
  if (typeof window === "undefined") return null;
  return parseStoredCases(window.localStorage.getItem(STORAGE_KEY_BACKUP));
}

/**
 * Returns true if a backup exists (so we can show "Restore previous").
 */
export function hasTestCasesBackup(): boolean {
  if (typeof window === "undefined") return false;
  const raw = window.localStorage.getItem(STORAGE_KEY_BACKUP);
  const parsed = parseStoredCases(raw);
  return parsed !== null && parsed.length > 0;
}

/**
 * Saves test cases to localStorage. Backs up the current list before overwriting (if non-empty).
 * Normalizes status to "queued" so we don't persist "running".
 */
export function saveTestCasesToStorage(testCases: TestCase[]): void {
  if (typeof window === "undefined") return;
  try {
    const current = window.localStorage.getItem(STORAGE_KEY);
    const currentParsed = parseStoredCases(current);
    if (currentParsed !== null && currentParsed.length > 0) {
      window.localStorage.setItem(STORAGE_KEY_BACKUP, current);
    }
    const toSave = testCases.map((tc) => ({
      id: tc.id,
      name: tc.name,
      steps: tc.steps,
      status: "queued" as const,
    }));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch {
    // ignore
  }
}
