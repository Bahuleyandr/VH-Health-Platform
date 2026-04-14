"use client";

// High-level hook that subscribes an admin-portal component to a VHHealth
// real-time fabric channel. Handles the two-step handshake:
//   1. POST /api/realtime-ticket → short-lived WS-scoped JWT
//   2. Open WebSocket to /ws?token=<ticket> and send subscribe
// Re-acquires a fresh ticket on every reconnect (tickets TTL ~60s).

import { useEffect, useRef, useState } from "react";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_URL || "https://api.vhhealth.app";

function wsUrlFromBase(httpBase: string, ticket: string): string {
  const u = new URL(httpBase);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/ws?token=${encodeURIComponent(ticket)}`;
}

export type RealtimeMessage<T = unknown> = {
  channel: string;
  data: T;
  receivedAt: number;
};

type Options = {
  /** Disable to pause the connection (e.g., while the page is hidden). */
  enabled?: boolean;
  /** Called with every event for the subscribed channel. */
  onEvent?: <T>(msg: RealtimeMessage<T>) => void;
};

/**
 * Subscribe to a single channel. The returned `lastMessage` updates on every
 * event; consumers that only care about state (e.g., KPI tiles) can read it
 * directly, while consumers that need to handle every event should pass
 * `onEvent`.
 */
export function useRealtimeChannel<T = unknown>(
  channel: string,
  { enabled = true, onEvent }: Options = {},
) {
  const [lastMessage, setLastMessage] = useState<RealtimeMessage<T> | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const connect = async () => {
      if (cancelled) return;
      let ticket: string;
      try {
        const res = await fetch("/api/realtime-ticket", {
          method: "POST",
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`ticket ${res.status}`);
        const body = (await res.json()) as { ticket?: string };
        if (!body.ticket) throw new Error("no ticket");
        ticket = body.ticket;
      } catch {
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
        return;
      }

      const ws = new WebSocket(wsUrlFromBase(API_BASE_URL, ticket));
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (cancelled) return;
        setConnected(true);
        backoffMs = 1000;
        ws.send(JSON.stringify({ action: "subscribe", channel }));
      });

      ws.addEventListener("message", (ev) => {
        let parsed: { event?: string; data?: unknown; channel?: string };
        try {
          parsed = JSON.parse(ev.data as string);
        } catch {
          return;
        }
        if (parsed.event !== channel) return;
        const msg: RealtimeMessage<T> = {
          channel,
          data: parsed.data as T,
          receivedAt: Date.now(),
        };
        setLastMessage(msg);
        onEventRef.current?.(msg);
      });

      ws.addEventListener("close", () => {
        setConnected(false);
        wsRef.current = null;
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30000);
      });

      ws.addEventListener("error", () => {
        // Close handler will schedule reconnect.
      });
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [channel, enabled]);

  return { lastMessage, connected };
}
