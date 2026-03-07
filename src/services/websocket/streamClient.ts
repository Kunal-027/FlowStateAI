"use client";

import type { WSServerMessage } from "./types";

export interface StreamClientConfig {
  url: string;
  onMessage: (message: WSServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
}

/**
 * WebSocket client for consuming remote browser stream (frame buffers).
 * Connects to the given URL and forwards parsed messages; frame messages
 * should be passed to the store (pushFrame) for the Canvas to render.
 */
export class StreamClient {
  private ws: WebSocket | null = null;
  private config: StreamClientConfig;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelayMs = 1000;

  /** Creates the client with the given config (url and callbacks for message, open, close, error). */
  constructor(config: StreamClientConfig) {
    this.config = config;
  }

  /** Opens the WebSocket connection and sets up event handlers; resets reconnect count on open. */
  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.config.url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.config.onOpen?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as WSServerMessage;
        this.config.onMessage(message);
      } catch {
        // Non-JSON or binary frame could be handled here
      }
    };

    this.ws.onclose = () => {
      this.config.onClose?.();
      this.tryReconnect();
    };

    this.ws.onerror = (error) => {
      this.config.onError?.(error);
    };
  }

  /** Schedules a reconnect after a delay if under max attempts; used when the connection closes. */
  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    setTimeout(() => this.connect(), this.reconnectDelayMs);
  }

  /** Sends a string or JSON-serializable object over the WebSocket (no-op if not open). */
  send(data: string | object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }

  /** Sends a subscribe message to start receiving frames for the given session id. */
  subscribe(sessionId: string): void {
    this.send({ type: "subscribe", sessionId });
  }

  /** Sends an unsubscribe message to stop receiving frames for the given session id. */
  unsubscribe(sessionId: string): void {
    this.send({ type: "unsubscribe", sessionId });
  }

  /** Closes the WebSocket and prevents further reconnects. Avoids closing while CONNECTING to prevent "closed before the connection is established" on unmount/Fast Refresh. */
  disconnect(): void {
    this.reconnectAttempts = this.maxReconnectAttempts;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WebSocket.CONNECTING) {
      ws.close();
    }
  }
}
