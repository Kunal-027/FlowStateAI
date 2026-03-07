"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Catches errors in the root segment and shows a friendly message instead of Internal Server Error. */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[App error]", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-lg font-semibold text-foreground">Something went wrong</h1>
      <p className="text-sm text-muted-foreground text-center max-w-md">
        {error.message || "An unexpected error occurred."}
      </p>
      <Button onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </main>
  );
}
