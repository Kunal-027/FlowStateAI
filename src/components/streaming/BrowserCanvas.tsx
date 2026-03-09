"use client";

import { useRef, useEffect, useState } from "react";
import { useExecutionStore, getExecutionState } from "@/store/useExecutionStore";
import { cn } from "@/lib/utils";

/** Bridge WebSocket URL (default port 4000; set NEXT_PUBLIC_BRIDGE_PORT or NEXT_PUBLIC_WS_STREAM_URL in env). */
const BRIDGE_WS_URL =
  typeof process.env.NEXT_PUBLIC_WS_STREAM_URL === "string" && process.env.NEXT_PUBLIC_WS_STREAM_URL
    ? process.env.NEXT_PUBLIC_WS_STREAM_URL
    : `ws://localhost:${process.env.NEXT_PUBLIC_BRIDGE_PORT || "4000"}`;

const DEFAULT_START_URL = "https://www.google.com";

/** Returns the URL to open for RUN_TEST: first step if it's a navigate, else default. */
function getStartUrlForTestCase(
  steps: { instruction?: string; payload?: { action?: string; url?: string } }[] | undefined
): string {
  const first = steps?.[0];
  if (!first) return DEFAULT_START_URL;
  if (first.payload?.action === "navigate" && first.payload.url) {
    return first.payload.url;
  }
  const navMatch = first.instruction?.match(/^(?:navigate|go to)\s+(https?:\/\/\S+)/i);
  if (navMatch) return navMatch[1].trim();
  return DEFAULT_START_URL;
}

export interface BrowserCanvasProps {
  /** Optional className for the wrapper div. */
  className?: string;
}

/**
 * State-aware streaming canvas: connects to the stream WebSocket only when the Zustand store
 * has a RUNNING test; disconnects when IDLE. Draws incoming base64 image messages onto the
 * canvas. Shows "Waiting for browser connection..." when disconnected.
 */
export function BrowserCanvas({ className }: BrowserCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lingerRef = useRef(false);
  const pendingStepRef = useRef<{
    resolve: (r: { success: boolean; error?: string; screenshot?: string }) => void;
    reject: (err: { success: false; error?: string; screenshot?: string }) => void;
  } | null>(null);
  const [connected, setConnected] = useState(false);
  const [navigationReady, setNavigationReady] = useState(false);
  const [liveInteract, setLiveInteract] = useState(false);

  const testCases = useExecutionStore((s) => s.testCases);
  const bridgeSend = useExecutionStore((s) => s.bridgeSend);
  const activeTestCaseId = useExecutionStore((s) => s.activeTestCaseId);
  const setStreamConnected = useExecutionStore((s) => s.setStreamConnected);
  const setStreamSession = useExecutionStore((s) => s.setStreamSession);
  const setBridgeSend = useExecutionStore((s) => s.setBridgeSend);
  const setExecuteStep = useExecutionStore((s) => s.setExecuteStep);
  const addLog = useExecutionStore((s) => s.addLog);
  const clearLogs = useExecutionStore((s) => s.clearLogs);
  const updateTestCase = useExecutionStore((s) => s.updateTestCase);

  const activeCase = activeTestCaseId
    ? testCases.find((tc) => tc.id === activeTestCaseId)
    : null;
  const isRunning = activeCase?.status === "running";

  /** Establishes WebSocket when RUNNING; disconnects when IDLE. Keeps last frame visible for 5s after test ends. */
  useEffect(() => {
    if (!isRunning) {
      lingerRef.current = true;
      setStreamConnected(false);
      setStreamSession(null);
      setBridgeSend(null);
      setExecuteStep(null);
      pendingStepRef.current?.reject({ success: false, error: "Test ended" });
      pendingStepRef.current = null;
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      const tid = window.setTimeout(() => {
        lingerRef.current = false;
        setConnected(false);
      }, 5000);
      return () => window.clearTimeout(tid);
    }

    const ws = new WebSocket(BRIDGE_WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setStreamConnected(true);
      /** Register send so execution service can send Playwright steps to this session. */
      setBridgeSend((msg: object) => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
        } catch {
          // ignore
        }
      });
      /** Session id is set when bridge sends session_started (see onmessage). */
      /** Register executeStep: send step and return a promise that resolves on step_done or rejects on error/ambiguity_error. */
      setExecuteStep((stepMsg: object) => {
        return new Promise((resolve, reject) => {
          pendingStepRef.current = {
            resolve: (r) => {
              pendingStepRef.current = null;
              resolve(r);
            },
            reject: (r) => {
              pendingStepRef.current = null;
              reject(r);
            },
          };
          try {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "step", ...stepMsg }));
          } catch (e) {
            pendingStepRef.current = null;
            reject({ success: false, error: (e as Error).message });
          }
        });
      });
      /** Tell the bridge to open the start URL from the *current* active test (read store here to avoid stale closure). */
      const state = getExecutionState();
      const active = state.activeTestCaseId
        ? state.testCases.find((tc) => tc.id === state.activeTestCaseId)
        : null;
      const startUrl = getStartUrlForTestCase(active?.steps);
      try {
        ws.send(JSON.stringify({ type: "RUN_TEST", url: startUrl }));
      } catch {
        // ignore
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const raw = event.data;
        if (typeof raw !== "string") return;
        const parsed = JSON.parse(raw) as {
          type?: string;
          data?: string;
          message?: string;
          target?: string;
          /** Base64 screenshot for this step (included with step_done for reports). */
          screenshot?: string;
          sessionId?: string;
          /** From bridge step_done: true = step passed, false = e.g. verify_displayed failed */
          success?: boolean;
          /** Which resolved this step: interpreter, huggingface, claude, visual_discovery */
          resolvedBy?: "interpreter" | "huggingface" | "claude" | "visual_discovery";
        };

        if (parsed.type === "session_started" && parsed.sessionId) {
          clearLogs();
          setStreamSession(parsed.sessionId);
          setNavigationReady(false);
          return;
        }
        if (parsed.type === "navigation_done") {
          setNavigationReady(true);
          return;
        }
        if (parsed.type === "log" && typeof parsed.message === "string") {
          const currentSessionId = getExecutionState().streamSessionId;
          if (parsed.sessionId != null && currentSessionId != null && parsed.sessionId !== currentSessionId) return;
          addLog({
            level: (parsed.level === "error" || parsed.level === "warn" ? parsed.level : "info") as "info" | "warn" | "error",
            message: parsed.message,
          });
          return;
        }
        if (parsed.type === "test_error") {
          const msg = parsed.message ?? "Test failed";
          const id = activeTestCaseId ?? undefined;
          if (id) updateTestCase(id, { status: "failed", error: msg, completedAt: new Date().toISOString() });
          pendingStepRef.current?.reject({ success: false, error: msg, screenshot: parsed.screenshot });
          pendingStepRef.current = null;
          return;
        }
        // Step finished: respect bridge's success flag so verify failures fail the run (no false "all passed")
        if (parsed.type === "step_done") {
          const success = parsed.success !== false;
          const screenshot = parsed.screenshot ?? undefined;
          if (success) {
            pendingStepRef.current?.resolve({
              success: true,
              screenshot,
              selfHealed: !!parsed.selfHealed,
              visualClick: !!parsed.visualClick,
              discoveryReason: parsed.discoveryReason ?? undefined,
              validationPassed: parsed.validationPassed,
              resolvedBy: parsed.resolvedBy,
            });
          } else {
            pendingStepRef.current?.reject({
              success: false,
              error: parsed.message ?? "Step failed",
              screenshot,
              expectedElement: parsed.expectedElement,
              actualPageContent: parsed.actualPageContent,
              resolvedBy: parsed.resolvedBy,
            });
            pendingStepRef.current = null;
          }
          return;
        }
        if (parsed.type === "error") {
          pendingStepRef.current?.reject({ success: false, error: parsed.message ?? "Unknown error" });
          return;
        }
        if (parsed.type === "ambiguity_error") {
          const msg = parsed.message ?? `Could not find "${parsed.target ?? "element"}" after 3 attempts.`;
          pendingStepRef.current?.reject({
            success: false,
            error: msg,
            screenshot: parsed.screenshot ?? undefined,
            expectedElement: parsed.expectedElement,
            actualPageContent: parsed.actualPageContent,
          });
          pendingStepRef.current = null;
          return;
        }

        if (parsed.type === "frame" && typeof parsed.data === "string") {
          const canvas = canvasRef.current;
          const ctx = canvas?.getContext("2d");
          if (!canvas || !ctx) return;
          const data = parsed.data;
          const img = new Image();
          img.onload = () => {
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
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      setNavigationReady(false);
      if (!lingerRef.current) {
        setConnected(false);
        setStreamConnected(false);
        setStreamSession(null);
        setBridgeSend(null);
        setExecuteStep(null);
      }
      pendingStepRef.current?.reject({ success: false, error: "Connection closed" });
      pendingStepRef.current = null;
    };

    ws.onerror = () => {
      setConnected(false);
    };

    return () => {
      setBridgeSend(null);
      setExecuteStep(null);
      pendingStepRef.current?.reject({ success: false, error: "Disconnected" });
      pendingStepRef.current = null;
      ws.close();
      wsRef.current = null;
      setConnected(false);
      setNavigationReady(false);
      setStreamConnected(false);
      setStreamSession(null);
    };
  }, [isRunning, setStreamConnected, setStreamSession, setBridgeSend, setExecuteStep, addLog, clearLogs, updateTestCase, activeTestCaseId]);

  /** Resizes the canvas to match the container size (responsive to the Monitor div) using ResizeObserver. */
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const resize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!liveInteract || !bridgeSend) return;
    const canvas = canvasRef.current;
    if (!canvas || e.target !== canvas) return;
    const x = e.nativeEvent.offsetX;
    const y = e.nativeEvent.offsetY;
    const canvasWidth = canvas.width || 1;
    const canvasHeight = canvas.height || 1;
    bridgeSend({
      type: "interact",
      action: "click",
      x,
      y,
      canvasWidth,
      canvasHeight,
    });
  };

  /** Non-passive wheel listener so we can preventDefault and forward scroll to the bridge. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!liveInteract || !bridgeSend || !canvas) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      bridgeSend({
        type: "interact",
        action: "scroll",
        deltaX: e.deltaX,
        deltaY: e.deltaY,
      });
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [liveInteract, bridgeSend]);

  /** When the WebSocket is disconnected, draws the fallback state: dark background and "Waiting for browser connection...". */
  useEffect(() => {
    if (connected) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width || 640;
    const h = canvas.height || 360;
    ctx.fillStyle = "#0d0d0d";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#404040";
    ctx.font = "14px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Waiting for browser connection...", w / 2, h / 2);
  }, [connected]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative overflow-hidden rounded-md border border-border bg-black flex flex-col flex-1 min-h-0 min-w-0 w-full h-full",
        className
      )}
      style={{ minHeight: 0 }}
    >
      {!connected && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-[#0d0d0d] px-4 text-center">
          <p className="text-muted-foreground text-sm">Waiting for browser connection…</p>
          <p className="text-muted-foreground/80 text-xs max-w-sm">
            Start the bridge so the monitor can stream the browser: run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">node bridge/server.js</code> or <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">npm run bridge</code> in the project root (port 4000).
          </p>
        </div>
      )}
      {connected && !navigationReady && isRunning && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </div>
      )}
      {connected && !isRunning && !liveInteract && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center">
          <p className="text-muted-foreground text-sm">Test ended.</p>
          <p className="text-muted-foreground/80 text-xs">Run another test to reconnect the browser.</p>
        </div>
      )}
      {connected && (
        <div className="absolute bottom-2 right-2 z-20 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setLiveInteract((v) => !v)}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              liveInteract
                ? "bg-emerald-600 text-white hover:bg-emerald-500"
                : "bg-muted/80 text-muted-foreground hover:bg-muted"
            )}
          >
            {liveInteract ? "Interact on" : "Interact"}
          </button>
          {liveInteract && (
            <>
              <span className="text-[10px] text-muted-foreground max-w-[120px]">Click or scroll on screen</span>
              <button
                type="button"
                onClick={() => bridgeSend?.({ type: "interact", action: "key", key: "Enter" })}
                className="rounded px-2 py-1 text-xs font-medium bg-muted/80 text-muted-foreground hover:bg-muted"
              >
                Send Enter
              </button>
            </>
          )}
        </div>
      )}
      <canvas
        ref={canvasRef}
        className={cn("block w-full h-full object-fill", liveInteract && "cursor-pointer")}
        style={{ width: "100%", height: "100%", display: "block" }}
        onClick={handleCanvasClick}
      />
    </div>
  );
}
