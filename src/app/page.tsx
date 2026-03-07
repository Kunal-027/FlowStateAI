import Link from "next/link";
import { AppBrand } from "@/components/AppBrand";

/** Landing page: app title, short description, and link to the Test Runner. */
export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <AppBrand className="mb-2" />
      <h1 className="sr-only">FlowState AI</h1>
      <p className="text-muted-foreground text-center max-w-md">
        High-reliability, cloud-native autonomous testing engine.
      </p>
      <Link
        href="/runner"
        className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:opacity-90 transition-opacity"
      >
        Open Test Runner
      </Link>
    </main>
  );
}
