import type { StreamFrame } from "@/types/execution";

/**
 * WebSocket message types for the remote browser stream and control channel.
 */
export type WSClientMessage =
  | { type: "subscribe"; sessionId: string }
  | { type: "unsubscribe"; sessionId: string }
  | { type: "ping" };

export type WSServerMessage =
  | StreamFrame
  | { type: "session_started"; sessionId: string }
  | { type: "session_ended"; sessionId: string }
  | { type: "pong" }
  | { type: "error"; message: string };
