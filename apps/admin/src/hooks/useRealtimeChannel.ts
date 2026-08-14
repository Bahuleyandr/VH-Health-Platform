"use client";

// High-level hook that subscribes an admin-portal component to a VHHealth
// real-time fabric channel. Handles the full handshake + keep-alive:
//   1. POST /api/realtime-ticket → short-lived WS-scoped JWT
//   2. Open WebSocket to /ws (NO token in the URL)
//   3. Send the ticket as the FIRST WS frame: {"action":"auth","token":<ticket>}
//      The backend wsServer accepts auth via header, ?token= query, OR this
//      first-frame message (see apps/backend/src/utils/websocket/wsServer.js).
//      We use the message form so the short-lived ticket never lands in proxy/
//      access logs or browser history (which a ?token= query string would).
//   4. Wait for the server's `connected` welcome — which the backend only sends
//      AFTER it has attached its persistent message handler — then send
//      `subscribe`. Sending `subscribe` before `connected` would race the
//      backend's one-shot auth-frame listener and could be dropped.
//   5. Wait for the server's `subscribed` ack before exposing
//      `subscribed: true` to consumers.
//   6. Emit app-level `ping` every 15s; force-reconnect if no `pong` lands
//      within 10s. Browsers hide the WS-frame ping from JS, so this is the
//      only way to detect a half-open TCP connection from the client.
// Re-acquires a fresh ticket on every reconnect (tickets TTL ~60s).

import { useEffect, useRef, useState } from "react";

const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;

// Build the bare /ws URL. The auth ticket is intentionally NOT in the query
// string — it is sent as the first WS frame instead (see connect() below) so
// it never leaks into access logs or browser history.
function wsUrlFromBase(base: string): string {
  const u = new URL(base);
  const scheme = u.protocol === "https:" || u.protocol === "wss:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}/ws`;
}

/**
 * Resolve the realtime socket URL. Prefers the `NEXT_PUBLIC_WS_URL` override
 * (same precedence as `WS_BASE_URL` in src/lib/api-config.ts — accepts
 * ws(s):// or http(s):// forms) so deployments can point the realtime fabric
 * at a different host; otherwise derives it from `NEXT_PUBLIC_API_URL`
 * exactly as before. Exported for tests.
 */
export function resolveWsUrl(): string {
  const override = process.env.NEXT_PUBLIC_WS_URL;
  if (override) {
    try {
      return wsUrlFromBase(override);
    } catch {
      // Unparseable override — fall through to the API-derived URL.
    }
  }
  return wsUrlFromBase(
    process.env.NEXT_PUBLIC_API_URL || "https://api.vhhealth.app",
  );
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
 *
 * Consumers should gate UI on `subscribed` (not `connected`) when they
 * need to know the server has actually accepted the subscription —
 * `connected` only says the socket is open.
 *
 * `latencyMs` is the last round-trip measured by the app-level ping/pong;
 * useful for surfacing a freshness indicator to the operator. `null`
 * until the first pong comes back.
 */
export function useRealtimeChannel<T = unknown>(
  channel: string,
  { enabled = true, onEvent }: Options = {},
) {
  const [lastMessage, setLastMessage] = useState<RealtimeMessage<T> | null>(null);
  const [connected, setConnected] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;

    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pingTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 1000;

    const clearKeepAlive = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (pongTimeoutTimer) { clearTimeout(pongTimeoutTimer); pongTimeoutTimer = null; }
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      clearKeepAlive();
      reconnectTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    };

    const startKeepAlive = (ws: WebSocket) => {
      clearKeepAlive();
      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const ts = Date.now();
        try {
          ws.send(JSON.stringify({ action: "ping", ts }));
        } catch {
          // if send fails, reconnect path will pick it up
          return;
        }
        // Arm a timeout — if no `pong` arrives, force-close so the
        // close handler reconnects.
        if (pongTimeoutTimer) clearTimeout(pongTimeoutTimer);
        pongTimeoutTimer = setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(4008, "pong timeout");
          }
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
    };

    async function connect() {
      if (cancelled) return;
      setDenied(null);
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
        scheduleReconnect();
        return;
      }

      const ws = new WebSocket(resolveWsUrl());
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (cancelled) return;
        backoffMs = 1000;
        // First frame MUST be the auth message (ticket off the URL). The
        // backend authenticates on this frame, then sends `connected`; we
        // defer `subscribe` + keep-alive until that welcome lands so we don't
        // race the backend's one-shot auth listener.
        try {
          ws.send(JSON.stringify({ action: "auth", token: ticket }));
        } catch {
          // send failed → close handler reconnects
          return;
        }
      });

      ws.addEventListener("message", (ev) => {
        type WireEvent = {
          event?: string;
          data?: unknown;
          channel?: string;
          reason?: string;
          userId?: string;
          ts?: number | null;
          serverTs?: number;
        };
        let parsed: WireEvent;
        try {
          parsed = JSON.parse(ev.data as string);
        } catch {
          return;
        }

        // Auth accepted: the backend emits `connected` only AFTER attaching its
        // persistent message handler, so it is now safe to subscribe + start
        // the keep-alive loop. This is the post-auth equivalent of the old
        // `open` handler.
        if (parsed.event === "connected") {
          if (cancelled || ws.readyState !== WebSocket.OPEN) return;
          setConnected(true);
          try {
            ws.send(JSON.stringify({ action: "subscribe", channel }));
          } catch {
            return;
          }
          startKeepAlive(ws);
          return;
        }

        // Keep-alive: compute RTT and reset the pong-timeout timer.
        if (parsed.event === "pong") {
          if (pongTimeoutTimer) { clearTimeout(pongTimeoutTimer); pongTimeoutTimer = null; }
          if (typeof parsed.ts === "number") {
            setLatencyMs(Math.max(0, Date.now() - parsed.ts));
          }
          return;
        }

        // Subscribe handshake.
        if (parsed.event === "subscribed" && parsed.channel === channel) {
          setSubscribed(true);
          setDenied(null);
          return;
        }
        if (parsed.event === "subscribe-denied" && parsed.channel === channel) {
          setSubscribed(false);
          setDenied(parsed.reason ?? "denied");
          return;
        }
        if (parsed.event === "unsubscribed" && parsed.channel === channel) {
          setSubscribed(false);
          return;
        }

        // Topic event for the channel we care about.
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
        setSubscribed(false);
        wsRef.current = null;
        clearKeepAlive();
        if (cancelled) return;
        scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        // Close handler will schedule reconnect.
      });
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearKeepAlive();
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [channel, enabled]);

  return { lastMessage, connected, subscribed, denied, latencyMs };
}
