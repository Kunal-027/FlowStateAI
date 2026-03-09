"use client";

import { Button } from "@/components/ui/button";
import Link from "next/link";
import { RunnerToolbar } from "@/components/runner/RunnerToolbar";

/** Runner page is client-only; layout uses force-dynamic so this segment is never statically built. */
export default function RunnerPage() {
  return (
    <div className="flex flex-col gap-4 border-t border-border pt-3">
      <RunnerToolbar />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <Link href="/">
            <Button variant="ghost" size="sm">← Home</Button>
          </Link>
        </div>
        <div className="rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-muted-foreground">
          <p className="mb-1.5 font-medium text-foreground">Run in terminal (from project root):</p>
          <p className="mb-1">App: <code className="rounded bg-muted px-1.5 py-0.5">npm run dev</code> — then open <code className="rounded bg-muted px-1.5 py-0.5">localhost:3000</code></p>
          <p>Bridge (for Monitor + real browser tests): <code className="rounded bg-muted px-1.5 py-0.5">npm run bridge:watch</code> — or <code className="rounded bg-muted px-1.5 py-0.5">npm run bridge</code></p>
        </div>
        <p className="text-xs text-muted-foreground">
          Choose <strong>Chromium</strong>, <strong>Firefox</strong>, or <strong>WebKit</strong> in the <strong>Browser (test runs in)</strong> dropdown above. The Monitor header shows which browser the test is running in; change it before clicking Run.
        </p>
      </div>
    </div>
  );
}
