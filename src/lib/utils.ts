import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merges Tailwind CSS class names with clsx and tailwind-merge.
 * Resolves conflicts (e.g. "p-2" and "p-4") so the last valid class wins.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ─── Date & duration helpers (for reporting) ─────────────────────────────────

/**
 * Formats an ISO date string for report display (e.g. "7 Mar 2026, 7:43 PM").
 * Uses en-GB style day-month-year; 12h time.
 */
export function formatReportDate(iso: string | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

/**
 * Returns duration in milliseconds between two ISO timestamps.
 * If either is missing, returns 0.
 */
export function durationMs(startIso: string | undefined, endIso: string | undefined): number {
  if (!startIso || !endIso) return 0;
  const a = new Date(startIso).getTime();
  const b = new Date(endIso).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, b - a);
}

/**
 * Formats a duration in ms as human-readable string (e.g. "2.3s", "1m 5s").
 */
export function formatDuration(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "0s";
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  if (min === 0) return `${sec}s`;
  const s = sec % 60;
  return s > 0 ? `${min}m ${s}s` : `${min}m`;
}
