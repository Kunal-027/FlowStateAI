"use client";

import { useEffect, useRef } from "react";
import { StreamClient } from "@/services/websocket";
import { useExecutionStore } from "@/store/useExecutionStore";
import type { WSServerMessage } from "@/services/websocket/types";

/** Must match the bridge server (see bridge/server.js, default port 4000). */
const WS_URL =
  process.env.NEXT_PUBLIC_WS_STREAM_URL ?? "ws://localhost:4000";

/**
 * Connects to the browser stream WebSocket when enabled; on each "frame" message pushes the frame
 * into the execution store (pushFrame). On session_started/session_ended updates stream session id.
 * Cleans up (disconnect, clear session) on unmount or when enabled becomes false.
 */
export function useStreamConnection(enabled: boolean = true): void {
  const pushFrame = useExecutionStore((s) => s.pushFrame);
  const setStreamSession = useExecutionStore((s) => s.setStreamSession);
  const setStreamConnected = useExecutionStore((s) => s.setStreamConnected);
  const clientRef = useRef<StreamClient | null>(null);

  /** Creates the WebSocket client, connects, and on unmount (or when enabled flips) disconnects and clears store session state. */
  useEffect(() => {
    if (!enabled) return;

    const client = new StreamClient({
      url: WS_URL,
      onMessage: (message: WSServerMessage) => {
        if (message.type === "frame") {
          pushFrame(message.data, message.width, message.height);
        }
        if (message.type === "session_started") {
          setStreamSession(message.sessionId);
        }
        if (message.type === "session_ended") {
          setStreamSession(null);
        }
      },
      onOpen: () => setStreamConnected(true),
      onClose: () => setStreamConnected(false),
    });

    clientRef.current = client;
    client.connect();

    return () => {
      client.disconnect();
      clientRef.current = null;
      setStreamConnected(false);
      setStreamSession(null);
    };
  }, [enabled, pushFrame, setStreamSession, setStreamConnected]);

  return;
}
