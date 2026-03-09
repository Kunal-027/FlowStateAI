import type { RunReport } from "@/types/execution";
import { formatReportDate, durationMs, formatDuration } from "@/lib/utils";

/**
 * Generates a standalone HTML report file (inline styles) for download/share.
 * Includes summary (pass/fail counts), duration, and a timeline of steps with
 * failed step details (expected vs actual + screenshot).
 */
export function exportReportAsHtml(report: RunReport): string {
  const steps = Array.isArray(report?.steps) ? report.steps : [];
  const pass = steps.filter((s) => s?.status === "success").length;
  const fail = steps.filter((s) => s?.status === "failed").length;
  const duration = formatDuration(durationMs(report?.startedAt, report?.completedAt));
  const statusColor = report?.status === "success" ? "#22c55e" : "#ef4444";
  const statusLabel = report?.status === "success" ? "Passed" : "Failed";

  const stepsHtml = steps
    .map((step) => {
      const isFailed = step?.status === "failed";
      const hasScreenshot = step?.screenshot != null;
      const screenshotLabel = isFailed ? "Screenshot at failure" : "Screenshot after step";
      const altText = isFailed ? "Failure" : "Step result";
      const screenshotHtml = hasScreenshot
        ? "<div class=\"screenshot\"><p class=\"label\">" +
          screenshotLabel +
          "</p><img src=\"data:image/png;base64," +
          (step?.screenshot ?? "") +
          "\" alt=\"" +
          altText +
          "\" /></div>"
        : "";
      const selfHealedBadge = step?.selfHealed
        ? '<span class="badge badge-heal">Self-healed</span>'
        : "";
      const visualClickBadge = step?.visualClick
        ? '<span class="badge badge-visual" title="' + escapeHtml(step?.discoveryReason ?? "AI Visual Discovery") + '">Visual Discovery</span>'
        : "";
      const resolvedByLabel =
        step?.resolvedBy === "interpreter"
          ? "Interpreter"
          : step?.resolvedBy === "huggingface"
            ? "Hugging Face"
            : step?.resolvedBy === "claude"
              ? "Claude (LLM)"
              : step?.resolvedBy === "visual_discovery"
                ? "Claude (Visual)"
                : "";
      const resolvedByBadge = resolvedByLabel
        ? '<span class="badge badge-resolved" title="Step resolved by ' + escapeHtml(resolvedByLabel) + '">' + escapeHtml(resolvedByLabel) + "</span>"
        : "";
      const discoveryDetail =
        step?.visualClick && step?.discoveryReason
          ? "<p class=\"discovery-detail\"><strong>Discovery:</strong> " + escapeHtml(step.discoveryReason) + (step?.validationPassed === true ? " · Validation passed" : step?.validationPassed === false ? " · Unverified" : "") + "</p>"
          : "";
      const expectedEl = step?.expectedElement ?? step?.instruction ?? "";
      const actualContent = step?.actualPageContent;
      const failureBlock =
        isFailed &&
        "<p><strong>Expected element:</strong> " +
          escapeHtml(expectedEl || "—") +
          "</p><p><strong>Error:</strong> <span class=\"error\">" +
          escapeHtml(step?.error ?? "Step failed") +
          "</span></p>" +
          (actualContent
            ? "<p><strong>Actual page content (snippet):</strong></p><pre class=\"actual-snippet\">" +
              escapeHtml(actualContent.slice(0, 3000)) +
              (actualContent.length > 3000 ? "…" : "") +
              "</pre>"
            : "");
      const detailHtml =
        isFailed || hasScreenshot || discoveryDetail
          ? "<div class=\"step-detail\">" +
            (failureBlock || "") +
            discoveryDetail +
            screenshotHtml +
            "</div>"
          : "";
      const stepClass = step?.status === "failed" ? "failed" : "";
      const stepIcon = step?.status === "success" ? "✓" : "✗";
      return (
        "<div class=\"step " +
        stepClass +
        "\">" +
        "<div class=\"step-header\">" +
        "<span class=\"step-icon\">" +
        stepIcon +
        "</span>" +
        selfHealedBadge +
        visualClickBadge +
        resolvedByBadge +
        "<span class=\"step-num\">" +
        ((step?.order ?? 0) + 1) +
        ".</span>" +
        "<span class=\"step-instr\">" +
        escapeHtml(step?.instruction ?? "") +
        "</span>" +
        "</div>" +
        detailHtml +
        "</div>"
      );
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FlowState Report — ${escapeHtml(report?.testCaseName ?? "Report")}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #e2e8f0; line-height: 1.5; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 1.5rem; margin: 0 0 8px; color: #f8fafc; }
    .meta { color: #94a3b8; font-size: 0.875rem; margin-bottom: 24px; }
    .summary { display: flex; align-items: center; gap: 24px; margin-bottom: 24px; padding: 16px; background: #1e293b; border-radius: 8px; }
    .summary-pie { width: 80px; height: 80px; border-radius: 50%; background: conic-gradient(#22c55e 0deg ${(pass / (pass + fail || 1)) * 360}deg, #ef4444 0deg); }
    .summary-stats { display: flex; gap: 16px; font-size: 0.875rem; }
    .summary-stats span { display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot.pass { background: #22c55e; }
    .dot.fail { background: #ef4444; }
    .status { font-weight: 600; margin-left: 8px; }
    .steps { margin-top: 16px; }
    .step { margin-bottom: 8px; border: 1px solid #334155; border-radius: 6px; overflow: hidden; background: #1e293b; }
    .step.failed { border-color: #7f1d1d; }
    .step-header { padding: 10px 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .step-icon { font-weight: bold; width: 20px; }
    .step.success .step-icon { color: #22c55e; }
    .step.failed .step-icon { color: #ef4444; }
    .step-num { color: #94a3b8; }
    .step-instr { flex: 1; }
    .badge-heal { background: rgba(139, 92, 246, 0.3); color: #a78bfa; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-visual { background: rgba(34, 197, 94, 0.25); color: #4ade80; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .badge-resolved { background: rgba(100, 116, 139, 0.3); color: #94a3b8; padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
    .step-detail { padding: 12px; border-top: 1px solid #334155; background: #0f172a; font-size: 0.875rem; }
    .step-detail p { margin: 0 0 8px; }
    .step-detail .error { color: #f87171; }
    .screenshot { margin-top: 8px; }
    .screenshot .label { color: #94a3b8; margin-bottom: 4px; }
    .screenshot img { max-width: 100%; border-radius: 4px; border: 1px solid #334155; }
    .actual-snippet { font-size: 0.75rem; max-height: 200px; overflow: auto; padding: 8px; background: #0f172a; border: 1px solid #334155; border-radius: 4px; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${escapeHtml(report?.testCaseName ?? "Report")}</h1>
    <p class="meta">${formatReportDate(report?.completedAt)} · Duration: ${duration}</p>
    <div class="summary">
      <div class="summary-pie"></div>
      <div>
        <span class="status" style="color: ${statusColor}">${statusLabel}</span>
        <div class="summary-stats">
          <span><span class="dot pass"></span> Pass ${pass}</span>
          <span><span class="dot fail"></span> Fail ${fail}</span>
        </div>
      </div>
    </div>
    <h2 style="font-size: 1rem; margin-bottom: 8px;">Steps</h2>
    <div class="steps">${stepsHtml}</div>
    <p class="meta" style="margin-top: 24px;">Generated by FlowState AI</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string | undefined | null): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
