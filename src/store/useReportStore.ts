import { create } from "zustand";
import type { RunReport, TestCase, TestStep } from "@/types/execution";

const STORAGE_KEY = "flowstate-reports";
const MAX_REPORTS = 100;

/** Load reports from localStorage (client-only). Used for hydration after mount. */
export function loadReportsFromStorage(): RunReport[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RunReport[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReports(reports: RunReport[]) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
  } catch {
    // ignore
  }
}

function loadReports(): RunReport[] {
  return loadReportsFromStorage();
}

/** Build a RunReport from a test case (call after run completes). */
export function buildReportFromTestCase(tc: TestCase): RunReport {
  const stepList = Array.isArray(tc?.steps) ? tc.steps : [];
  const steps: RunReport["steps"] = [...stepList]
    .sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0))
    .map((s: TestStep) => ({
      stepId: s.id,
      order: s.order,
      instruction: s.instruction,
      status: s.status,
      error: s.error,
      screenshot: s.screenshot,
      selfHealed: (s.healingAttempts ?? 0) > 0,
      visualClick: s.visualClick,
      discoveryReason: s.discoveryReason,
      validationPassed: s.validationPassed,
      resolvedBy: s.resolvedBy,
      expectedElement: s.expectedElement,
      actualPageContent: s.actualPageContent,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
    }));
  return {
    id: `report-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    testCaseId: tc?.id ?? "",
    testCaseName: tc?.name ?? "Unnamed",
    status: tc?.status ?? "failed",
    startedAt: tc?.startedAt ?? tc?.completedAt ?? new Date().toISOString(),
    completedAt: tc?.completedAt ?? new Date().toISOString(),
    error: tc?.error,
    steps,
  };
}

export interface ReportState {
  reports: RunReport[];
  /** Id of the report to show in the Reports tab (e.g. latest after a run). */
  selectedReportId: string | null;
  /** When true, UI should switch to Reports tab and then clear this (e.g. after run completes). */
  shouldOpenReportsTab: boolean;
  /** When true, UI should switch to Monitor tab and then clear this (e.g. when user clicks Run). */
  shouldOpenMonitorTab: boolean;
}

export interface ReportActions {
  addReport: (report: RunReport) => void;
  setSelectedReportId: (id: string | null) => void;
  clearShouldOpenReportsTab: () => void;
  /** Set flag so layout switches to Monitor tab (call when starting a run). */
  openMonitorTab: () => void;
  clearShouldOpenMonitorTab: () => void;
  clearReports: () => void;
  getReportById: (id: string) => RunReport | undefined;
  /** Load reports from localStorage (call once after mount on client). */
  hydrateFromStorage: () => void;
}

/** Always start with empty reports; hydrate from localStorage in ReportsPanel to avoid SSR/window issues. */
const initialState: ReportState = {
  reports: [],
  selectedReportId: null,
  shouldOpenReportsTab: false,
  shouldOpenMonitorTab: false,
};

export const useReportStore = create<ReportState & ReportActions>((set, get) => ({
  ...initialState,

  addReport: (report) =>
    set((state) => {
      const next = [report, ...state.reports].slice(0, MAX_REPORTS);
      saveReports(next);
      return {
        reports: next,
        selectedReportId: report.id,
        shouldOpenReportsTab: true,
      };
    }),

  setSelectedReportId: (selectedReportId) => set({ selectedReportId }),

  clearShouldOpenReportsTab: () => set({ shouldOpenReportsTab: false }),

  openMonitorTab: () => set({ shouldOpenMonitorTab: true }),
  clearShouldOpenMonitorTab: () => set({ shouldOpenMonitorTab: false }),

  clearReports: () => {
    saveReports([]);
    set({ reports: [], selectedReportId: null, shouldOpenReportsTab: false, shouldOpenMonitorTab: false });
  },

  getReportById: (id) => get().reports.find((r) => r.id === id),

  hydrateFromStorage: () => {
    const stored = loadReportsFromStorage();
    if (stored.length > 0) set((s) => (s.reports.length === 0 ? { reports: stored } : {}));
  },
}));
