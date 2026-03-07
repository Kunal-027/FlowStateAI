import { RunnerLayoutClient } from "@/components/runner/RunnerLayoutClient";

export const dynamic = "force-dynamic";

/** Layout for /runner: delegates to client component so dynamic(ssr: false) is allowed. */
export default function RunnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RunnerLayoutClient>{children}</RunnerLayoutClient>;
}
