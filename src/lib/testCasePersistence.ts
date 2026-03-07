import type { TestCase } from "@/types/execution";

const STORAGE_KEY = "flowstate-test-cases";
const STORAGE_KEY_BACKUP = "flowstate-test-cases-backup";

function parseStoredCases(raw: string | null): TestCase[] | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    const cases = parsed.map((item) => {
      const tc = item as Record<string, unknown>;
      if (!tc || typeof tc.id !== "string" || typeof tc.name !== "string" || !Array.isArray(tc.steps))
        return null;
      return {
        id: tc.id,
        name: tc.name,
        steps: tc.steps as TestCase["steps"],
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
