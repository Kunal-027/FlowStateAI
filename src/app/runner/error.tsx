"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/** Catches errors in the runner segment so users see a message instead of Internal Server Error. */
export default function RunnerError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[Runner error]", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-lg font-semibold text-foreground">Runner error</h1>
      <p className="text-sm text-muted-foreground text-center max-w-md">
        {error.message || "Something went wrong in the Test Runner."}
      </p>
      <div className="flex gap-2">
        <Button onClick={reset} variant="outline" size="sm">
          Try again
        </Button>
        <Link href="/">
          <Button variant="ghost" size="sm">
            ← Home
          </Button>
        </Link>
      </div>
    </main>
  );
}
