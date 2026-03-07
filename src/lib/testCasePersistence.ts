import type { TestCase } from "@/types/execution";

const STORAGE_KEY = "flowstate-test-cases";

/**
 * Loads test cases from localStorage.
 * - Returns TestCase[] (maybe empty) if key exists and parsed OK.
 * - Returns null only if key is missing or parse error (so caller can seed mocks).
 * Loaded cases are normalized to status "queued" so we don't restore "running".
 */
export function loadTestCasesFromStorage(): TestCase[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === "") return null;
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
 * Saves test cases to localStorage. Normalizes status to "queued" so we don't persist "running".
 */
export function saveTestCasesToStorage(testCases: TestCase[]): void {
  if (typeof window === "undefined") return;
  try {
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
