"use client";

import dynamic from "next/dynamic";
import { AppBrand } from "@/components/AppBrand";

/** Client-only wrapper: loads ResizableRunnerLayout with ssr: false to avoid SSR of client-only modules. */
const ResizableRunnerLayout = dynamic(
  () => import("@/components/runner/ResizableRunnerLayout").then((m) => ({ default: m.ResizableRunnerLayout })),
  { ssr: false }
);

export function RunnerLayoutClient({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen w-full flex-col bg-background">
      <header className="flex items-center shrink-0 border-b border-border bg-card/60 px-4 py-2">
        <AppBrand href="/" />
      </header>
      <ResizableRunnerLayout>{children}</ResizableRunnerLayout>
    </div>
  );
}
