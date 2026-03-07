import Link from "next/link";
import { AppBrand } from "@/components/AppBrand";
import { Button } from "@/components/ui/button";
import {
  Play,
  Zap,
  Shield,
  BarChart3,
  FileCode,
  Bug,
  ArrowRight,
  CheckCircle2,
} from "lucide-react";

/** Landing page: hero, features, how it works, CTA. Dark, sleek, cloud-browser platform style. */
export default function HomePage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <AppBrand />
          </Link>
          <Link href="/runner">
            <Button size="sm" className="gap-2 font-medium">
              <Play className="h-4 w-4" />
              Runner
            </Button>
          </Link>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-border/40 px-4 py-20 sm:px-6 sm:py-28">
          <div className="absolute inset-0 bg-gradient-to-b from-accent/5 via-transparent to-transparent" />
          <div className="relative mx-auto max-w-4xl text-center">
            <h1 className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl md:text-6xl">
              Autonomous testing.
              <br />
              <span className="text-accent">Built for the browser.</span>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-muted-foreground">
              High-reliability, cloud-native test automation. Write steps in plain English, run in a real browser, and ship with confidence.
            </p>
            <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
              <Link href="/runner">
                <Button size="lg" className="gap-2 text-base font-semibold shadow-lg shadow-accent/20">
                  <Play className="h-5 w-5" />
                  Open Runner
                </Button>
              </Link>
              <Link href="/runner">
                <Button variant="outline" size="lg" className="gap-2 text-base">
                  See how it works
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Features */}
        <section className="px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-center text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Everything you need to ship quality
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-muted-foreground">
              From authoring to execution to reporting — one platform for reliable browser test automation.
            </p>
            <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: FileCode,
                  title: "Plain-English steps",
                  description: "Write tests the way you think: click, fill, navigate, verify. No selectors to maintain.",
                },
                {
                  icon: Zap,
                  title: "AI-powered execution",
                  description: "Dynamic element resolution and optional self-healing so tests adapt when the UI changes.",
                },
                {
                  icon: Shield,
                  title: "Real browser, real results",
                  description: "Runs in Chromium, Firefox, or WebKit. See every step live in the monitor and stream.",
                },
                {
                  icon: BarChart3,
                  title: "Professional reports",
                  description: "Pass/fail summary, searchable timeline, per-step screenshots, and export to HTML to share.",
                },
                {
                  icon: Bug,
                  title: "Precision debugging",
                  description: "Failed steps show expected vs actual and a screenshot so you fix issues fast.",
                },
                {
                  icon: CheckCircle2,
                  title: "Verify as you go",
                  description: "Assert that elements or text are displayed. Fail the run when verification fails — no false positives.",
                },
              ].map(({ icon: Icon, title, description }) => (
                <div
                  key={title}
                  className="group rounded-xl border border-border/80 bg-card/50 p-6 transition-all hover:border-accent/40 hover:bg-card/80"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent transition-colors group-hover:bg-accent/20">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold text-foreground">{title}</h3>
                  <p className="mt-2 text-sm text-muted-foreground">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-border/40 bg-muted/20 px-4 py-16 sm:px-6 sm:py-24">
          <div className="mx-auto max-w-6xl">
            <h2 className="text-center text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              How it works
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-center text-muted-foreground">
              Three steps from idea to confidence.
            </p>
            <div className="mt-16 grid gap-8 md:grid-cols-3">
              {[
                { step: "1", title: "Write test steps", body: "Add a test case and describe steps in plain English. Navigate, fill forms, click buttons, and add verify steps." },
                { step: "2", title: "Run in the browser", body: "Start the bridge and run. Watch the live browser stream and console as each step executes in Chromium, Firefox, or WebKit." },
                { step: "3", title: "Review and share", body: "Check the Reports tab: pass/fail pie chart, searchable timeline, and export a standalone HTML report for your team." },
              ].map(({ step, title, body }) => (
                <div key={step} className="relative rounded-xl border border-border/80 bg-card/50 p-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-accent/50 bg-background text-lg font-bold text-accent">
                    {step}
                  </div>
                  <h3 className="mt-4 text-xl font-semibold text-foreground">{title}</h3>
                  <p className="mt-2 text-muted-foreground">{body}</p>
                </div>
              ))}
            </div>
            <div className="mt-14 text-center">
              <Link href="/runner">
                <Button size="lg" className="gap-2 font-semibold">
                  <Play className="h-5 w-5" />
                  Launch Runner
                </Button>
              </Link>
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="border-t border-border/40 px-4 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-3xl rounded-2xl border border-border/80 bg-card/50 p-8 text-center sm:p-12">
            <h2 className="text-2xl font-bold text-foreground sm:text-3xl">
              Ready to run your tests?
            </h2>
            <p className="mt-3 text-muted-foreground">
              Open the Runner to author test cases, run them in a real browser, and view reports.
            </p>
            <Link href="/runner" className="mt-6 inline-block">
              <Button size="lg" className="gap-2 font-semibold">
                <Play className="h-5 w-5" />
                Open Runner
              </Button>
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/40 px-4 py-8 sm:px-6">
        <div className="mx-auto flex max-w-6xl items-center justify-between text-sm text-muted-foreground">
          <span>FlowState AI</span>
          <Link href="/runner" className="font-medium text-accent hover:underline">
            Runner →
          </Link>
        </div>
      </footer>
    </div>
  );
}
