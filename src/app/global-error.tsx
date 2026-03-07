"use client";

/**
 * Catches errors in the root layout. Must define its own <html> and <body>.
 * Shows a simple message instead of the default Internal Server Error page.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background font-sans text-foreground flex flex-col items-center justify-center p-8">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-muted-foreground mt-2 text-center max-w-md">
          {error?.message ?? "An unexpected error occurred."}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          className="mt-4 rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
