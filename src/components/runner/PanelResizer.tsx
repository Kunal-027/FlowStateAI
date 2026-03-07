"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

const RESIZER_WIDTH = 6;

export interface PanelResizerProps {
  /** Callback with delta in pixels (positive = drag right/down). */
  onDrag: (deltaPx: number) => void;
  /** Optional class for the hit area. */
  className?: string;
  /** "vertical" = divider between left/right panels (drag horizontal). "horizontal" = divider between top/bottom. */
  direction?: "vertical" | "horizontal";
}

/**
 * Draggable divider between two panels. On drag, calls onDrag(deltaPx).
 */
export function PanelResizer({
  onDrag,
  className,
  direction = "vertical",
}: PanelResizerProps) {
  const [dragging, setDragging] = useState(false);
  const startRef = useRef({ x: 0, y: 0 });

  const handleMove = useCallback(
    (e: MouseEvent) => {
      const delta = direction === "vertical" ? e.clientX - startRef.current.x : e.clientY - startRef.current.y;
      startRef.current = { x: e.clientX, y: e.clientY };
      onDrag(delta);
    },
    [onDrag, direction]
  );

  const handleUp = useCallback(() => {
    setDragging(false);
    window.removeEventListener("mousemove", handleMove);
    window.removeEventListener("mouseup", handleUp);
  }, [handleMove]);

  useEffect(() => {
    if (!dragging) return;
    window.addEventListener("mousemove", handleMove);
    window.addEventListener("mouseup", handleUp);
    return () => {
      window.removeEventListener("mousemove", handleMove);
      window.removeEventListener("mouseup", handleUp);
    };
  }, [dragging, handleMove, handleUp]);

  const hitStyle =
    direction === "vertical"
      ? { width: RESIZER_WIDTH, minWidth: RESIZER_WIDTH, cursor: "col-resize" as const }
      : { height: RESIZER_WIDTH, minHeight: RESIZER_WIDTH, cursor: "row-resize" as const };

  return (
    <div
      role="separator"
      aria-orientation={direction}
      className={cn(
        "shrink-0 flex items-center justify-center bg-transparent hover:bg-border/50 transition-colors select-none",
        direction === "vertical" && "flex-col",
        dragging && "bg-primary/20",
        className
      )}
      style={hitStyle}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        startRef.current = { x: e.clientX, y: e.clientY };
        setDragging(true);
      }}
    >
      <div
        className={cn(
          "rounded-full bg-muted-foreground/30 pointer-events-none",
          direction === "vertical" ? "w-0.5 h-8" : "h-0.5 w-8"
        )}
      />
    </div>
  );
}
