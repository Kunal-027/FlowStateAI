"use client";

/** Wraps the Runner layout. The bridge connection is handled by BrowserCanvas when a test runs (single connection per run). */
export function RunnerStreamProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
