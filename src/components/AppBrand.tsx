"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

/** FlowState AI logo mark: play + flow lines. */
function LogoIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="1.5" className="opacity-80" />
      <path
        d="M13 10l7 6-7 6V10z"
        fill="currentColor"
        className="text-accent"
      />
      <path
        d="M6 16h3M23 16h3M16 6v3M16 23v3"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        className="opacity-50"
      />
    </svg>
  );
}

export interface AppBrandProps {
  className?: string;
  compact?: boolean;
  /** When set, logo and name link to this URL (e.g. "/" for home). */
  href?: string;
}

/**
 * App name and logo for corners. Use compact in tight spaces. Pass href (e.g. "/") to make it clickable to home.
 */
export function AppBrand({ className, compact, href }: AppBrandProps) {
  const content = (
    <>
      <LogoIcon className={compact ? "h-6 w-6" : "h-8 w-8"} />
      <span
        className={cn(
          "font-semibold text-foreground tracking-tight",
          compact ? "text-xs" : "text-sm"
        )}
      >
        FlowState AI
      </span>
    </>
  );
  const wrapperClass = cn(
    "flex items-center gap-2 shrink-0",
    compact ? "gap-1.5" : "gap-2",
    href && "hover:opacity-90 transition-opacity",
    className
  );
  if (href) {
    return (
      <Link href={href} className={wrapperClass} aria-label="Go to home">
        {content}
      </Link>
    );
  }
  return <div className={wrapperClass}>{content}</div>;
}
