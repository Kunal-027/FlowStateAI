"use client";

import { useRef, useEffect, useState } from "react";
import { useExecutionStore, getExecutionState } from "@/store/useExecutionStore";
import { cn } from "@/lib/utils";

/** Bridge WebSocket URL (Express + ws server on port 4000). */
const BRIDGE_WS_URL = "ws://localhost:4000";

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

  const testCases = useExecutionStore((s) => s.testCases);
  const activeTestCaseId = useExecutionStore((s) => s.activeTestCaseId);
  const setStreamConnected = useExecutionStore((s) => s.setStreamConnected);
  const setStreamSession = useExecutionStore((s) => s.setStreamSession);
  const setBridgeSend = useExecutionStore((s) => s.setBridgeSend);
  const setExecuteStep = useExecutionStore((s) => s.setExecuteStep);
  const addLog = useExecutionStore((s) => s.addLog);
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
          screenshot?: string;
          sessionId?: string;
        };

        if (parsed.type === "session_started" && parsed.sessionId) {
          setStreamSession(parsed.sessionId);
          setNavigationReady(false);
          return;
        }
        if (parsed.type === "navigation_done") {
          setNavigationReady(true);
          return;
        }
        if (parsed.type === "log" && typeof parsed.message === "string") {
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
        if (parsed.type === "step_done") {
          pendingStepRef.current?.resolve({ success: true });
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
  }, [isRunning, setStreamConnected, setStreamSession, setBridgeSend, setExecuteStep, addLog, updateTestCase, activeTestCaseId]);

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
            Start the bridge so the monitor can stream the browser: run <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">node bridge/server.js</code> in the project root (port 4000).
          </p>
        </div>
      )}
      {connected && !navigationReady && isRunning && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/70">
          <p className="text-muted-foreground text-sm">Loading…</p>
        </div>
      )}
      {connected && !isRunning && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/60 px-4 text-center">
          <p className="text-muted-foreground text-sm">Test ended.</p>
          <p className="text-muted-foreground/80 text-xs">Run another test to reconnect the browser.</p>
        </div>
      )}
      <canvas
        ref={canvasRef}
        className="block w-full h-full object-fill"
        style={{ width: "100%", height: "100%", display: "block" }}
      />
    </div>
  );
}
