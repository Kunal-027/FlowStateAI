import { RunnerStreamProvider } from "@/components/runner/RunnerStreamProvider";
import { ResizableRunnerLayout } from "@/components/runner/ResizableRunnerLayout";
import { AppBrand } from "@/components/AppBrand";

/** Layout for /runner: resizable Test Cases | Console | Monitor panels. */
export default function RunnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <RunnerStreamProvider>
      <div className="flex h-screen w-full flex-col bg-background">
        <header className="flex items-center shrink-0 border-b border-border bg-card/60 px-4 py-2">
          <AppBrand />
        </header>
        <ResizableRunnerLayout>{children}</ResizableRunnerLayout>
      </div>
    </RunnerStreamProvider>
  );
}
