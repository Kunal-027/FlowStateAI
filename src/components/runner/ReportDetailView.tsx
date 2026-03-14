"use client";

import { useState } from "react";
import { formatReportDate, durationMs, formatDuration } from "@/lib/utils";
import { exportReportAsHtml } from "@/lib/reportExport";
import { ReportSummaryPie } from "@/components/runner/ReportSummaryPie";
import { ReportTimeline } from "@/components/runner/ReportTimeline";
import { Button } from "@/components/ui/button";
import type { RunReport } from "@/types/execution";
import { Download, Search } from "lucide-react";

/** Single report view: summary pie, searchable timeline, export HTML button. */
export function ReportDetailView({ report }: { report: RunReport }) {
  const [search, setSearch] = useState("");
  const pass = report.steps.filter((s) => s.status === "success").length;
  const fail = report.steps.filter((s) => s.status === "failed").length;
  const cacheHits = report.steps.filter((s) => s.cacheHit).length;
  const aiHeals = report.steps.filter((s) => s.aiHeal).length;
  const duration = formatDuration(durationMs(report.startedAt, report.completedAt));

  const handleExport = () => {
    const html = exportReportAsHtml(report);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `flowstate-report-${report.testCaseName.replace(/\s+/g, "-")}-${report.id.slice(-6)}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-4 h-full min-h-0">
      <div className="shrink-0 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{report.testCaseName}</h2>
          <p className="text-xs text-muted-foreground">
            {formatReportDate(report.completedAt)} · {duration}
            {report.error && (
              <span className="text-destructive ml-1"> · {report.error}</span>
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleExport} className="gap-1.5">
          <Download className="h-3.5 w-3.5" />
          Export HTML Report
        </Button>
      </div>

      <div className="shrink-0 grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="rounded-lg border border-border bg-card p-4 flex items-center justify-center">
          <ReportSummaryPie pass={pass} fail={fail} size={100} />
        </div>
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col justify-center text-sm">
          <p className="text-muted-foreground">
            Total steps: <span className="font-medium text-foreground">{report.steps.length}</span>
          </p>
          <p className="text-muted-foreground">
            Status:{" "}
            <span
              className={
                report.status === "success"
                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                  : "font-medium text-destructive"
              }
            >
              {report.status === "success" ? "Passed" : "Failed"}
            </span>
          </p>
          {(cacheHits > 0 || aiHeals > 0) && (
            <p className="text-muted-foreground mt-1">
              Cache hits: <span className="font-medium text-teal-600 dark:text-teal-400">{cacheHits}</span>
              {" · "}
              AI heals: <span className="font-medium text-amber-600 dark:text-amber-400">{aiHeals}</span>
            </p>
          )}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <input
          type="search"
          placeholder="Search steps or errors..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        <ReportTimeline steps={report.steps} searchQuery={search} />
      </div>
    </div>
  );
}
