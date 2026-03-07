"use client";

import { useEffect } from "react";
import { useReportStore } from "@/store/useReportStore";
import { formatReportDate } from "@/lib/utils";
import { ReportDetailView } from "@/components/runner/ReportDetailView";
import { cn } from "@/lib/utils";
import { FileText } from "lucide-react";

/**
 * Reports tab content: list of past runs (from store) and a detail view
 * with summary pie, searchable timeline, and Export HTML.
 */
export function ReportsPanel({ className }: { className?: string }) {
  const reports = useReportStore((s) => s.reports);
  const selectedReportId = useReportStore((s) => s.selectedReportId);
  const setSelectedReportId = useReportStore((s) => s.setSelectedReportId);
  const getReportById = useReportStore((s) => s.getReportById);
  const hydrateFromStorage = useReportStore((s) => s.hydrateFromStorage);

  useEffect(() => {
    hydrateFromStorage();
  }, [hydrateFromStorage]);

  const selectedReport = selectedReportId ? getReportById(selectedReportId) : null;

  return (
    <div
      className={cn(
        "flex flex-col h-full min-h-0 rounded-lg border border-border bg-card overflow-hidden",
        className
      )}
    >
      <div className="shrink-0 border-b border-border px-3 py-2 flex items-center gap-2">
        <FileText className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold text-foreground">Reports</h2>
      </div>
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <aside className="w-56 shrink-0 border-r border-border overflow-auto flex flex-col">
          {reports.length === 0 ? (
            <p className="p-3 text-xs text-muted-foreground">
              No reports yet. Run a test to see a report here.
            </p>
          ) : (
            <ul className="p-1">
              {reports.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedReportId(r.id)}
                    className={cn(
                      "w-full text-left px-2 py-2 rounded-md text-xs transition-colors",
                      selectedReportId === r.id
                        ? "bg-primary/15 text-primary font-medium"
                        : "hover:bg-muted/50 text-foreground"
                    )}
                  >
                    <span className="block truncate font-medium">{r.testCaseName}</span>
                    <span className="block truncate text-muted-foreground mt-0.5">
                      {formatReportDate(r.completedAt)} · {r.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <main className="flex-1 min-w-0 overflow-auto p-4">
          {selectedReport ? (
            <ReportDetailView report={selectedReport} />
          ) : (
            <p className="text-sm text-muted-foreground py-8 text-center">
              Select a report from the list or run a test to generate one.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
