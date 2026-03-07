"use client";

import { cn } from "@/lib/utils";

/** Simple SVG pie chart: Pass vs Fail step counts. */
export function ReportSummaryPie({
  pass,
  fail,
  size = 120,
  className,
}: {
  pass: number;
  fail: number;
  size?: number;
  className?: string;
}) {
  const total = pass + fail;
  const passAngle = total === 0 ? 0 : (pass / total) * 360;
  const failAngle = total === 0 ? 0 : (fail / total) * 360;
  const r = 0.4;
  const cx = 0.5;
  const cy = 0.5;
  const toCoord = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  };
  const [x1, y1] = toCoord(0);
  const [x2, y2] = toCoord(passAngle);
  const [x3, y3] = toCoord(passAngle + failAngle);
  const largePass = passAngle > 180 ? 1 : 0;
  const largeFail = failAngle > 180 ? 1 : 0;
  const pathPass =
    total === 0 || pass === 0
      ? ""
      : `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${largePass} 1 ${x2} ${y2} Z`;
  const pathFail =
    total === 0 || fail === 0
      ? ""
      : `M ${cx} ${cy} L ${x2} ${y2} A ${r} ${r} 0 ${largeFail} 1 ${x3} ${y3} Z`;

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <svg
        viewBox="0 0 1 1"
        className="aspect-square w-full max-w-[120px]"
        style={{ width: size, height: size }}
      >
        {total > 0 && (
          <>
            <path d={pathPass} fill="var(--chart-pass, #22c55e)" />
            <path d={pathFail} fill="var(--chart-fail, #ef4444)" />
          </>
        )}
        {total === 0 && (
          <circle cx={cx} cy={cy} r={r} fill="var(--muted)" opacity={0.3} />
        )}
      </svg>
      <div className="flex flex-wrap justify-center gap-3 text-xs">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
          Pass {pass}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-destructive" />
          Fail {fail}
        </span>
      </div>
    </div>
  );
}
