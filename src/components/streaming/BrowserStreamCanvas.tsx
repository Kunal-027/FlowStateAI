"use client";

import { useCallback, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export interface BrowserStreamCanvasProps {
  /** Base64-encoded image data (from WebSocket frame) */
  frameData: string | null;
  width: number;
  height: number;
  /** Whether the stream is connected */
  connected: boolean;
  className?: string;
}

/**
 * HTML5 Canvas component that consumes WebSocket frame buffers from remote browser sessions.
 * Renders each frame as an image on the canvas for low-latency display.
 */
export function BrowserStreamCanvas({
  frameData,
  width,
  height,
  connected,
  className,
}: BrowserStreamCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /** Draws a single frame (base64 image) onto the canvas; on error draws a fallback message. */
  const drawFrame = useCallback(
    (data: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const img = new Image();
      img.onload = () => {
        canvas.width = width || img.width;
        canvas.height = height || img.height;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      };
      img.onerror = () => {
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#666";
        ctx.font = "14px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("Frame decode error", canvas.width / 2, canvas.height / 2);
      };
      img.src = data.startsWith("data:") ? data : `data:image/png;base64,${data}`;
    },
    [width, height]
  );

  /** When frameData exists, draws it on the canvas; otherwise draws the idle/placeholder state (waiting or disconnected). */
  useEffect(() => {
    if (frameData) {
      drawFrame(frameData);
    } else {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = width || 1280;
      canvas.height = height || 720;
      ctx.fillStyle = "#0d0d0d";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#404040";
      ctx.font = "14px system-ui";
      ctx.textAlign = "center";
      ctx.fillText(
        connected ? "Waiting for frames…" : "Stream disconnected",
        canvas.width / 2,
        canvas.height / 2
      );
    }
  }, [frameData, width, height, connected, drawFrame]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-black",
        className
      )}
    >
      <canvas
        ref={canvasRef}
        className="block w-full h-full object-contain"
        style={{ maxWidth: "100%", maxHeight: "100%" }}
      />
      {!connected && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/80">
          <span className="text-sm text-muted-foreground">
            No active session
          </span>
        </div>
      )}
    </div>
  );
}
