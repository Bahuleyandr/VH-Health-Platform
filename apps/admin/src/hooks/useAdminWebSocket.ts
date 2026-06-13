// src/hooks/useAdminWebSocket.ts
//
// @deprecated No callers exist in the admin portal. The real-time channel is
// consumed via the ticket-based useWebSocket in the dashboard entry point.
// Remove this file once the audit-7 cleanup branch is merged.
import { useCallback } from "react";
import { useWebSocket } from "./useWebSocket";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { WS_BASE_URL } from "@/lib/api-config";

// ── Message types ────────────────────────────────────────────────────────────

export interface SystemAlertMessage {
  type: "system-alert";
  message: string;
}

export interface SosAlertMessage {
  type: "sos-alert";
  message: string;
  severity?: "HIGH" | "MEDIUM" | "LOW";
  alertId?: string;
}

export interface StatsUpdateMessage {
  type: "stats-update";
  module?: string;
  data?: unknown;
}

export interface ActivityMessage {
  type: "activity";
  action?: string;
  userId?: string;
  timestamp?: string;
}

export type AdminWebSocketMessage =
  | SystemAlertMessage
  | SosAlertMessage
  | StatsUpdateMessage
  | ActivityMessage;

// Backend event → normalized AdminWebSocketMessage type mapping
const EVENT_TYPE_MAP: Record<string, AdminWebSocketMessage["type"]> = {
  "sos-alert":            "sos-alert",
  "system-alert":         "system-alert",
  "stats-update":         "stats-update",
  "activity":             "activity",
  // Backend channel names that map to portal message types
  "appointment-updates":  "stats-update",
  "queue-updates":        "stats-update",
};

// Channels the admin portal subscribes to after connecting
const ADMIN_CHANNELS = ["sos-alert", "system-alert", "stats-update", "activity", "appointment-updates", "queue-updates"];

export function useAdminWebSocket() {
  const queryClient = useQueryClient();

  // Backend WS is at /ws (single path, channel-subscription model)
  const base = WS_BASE_URL.replace(/\/+$/, "");
  const url = `${base}/ws`;

  const { isConnected, connectionState, send, sendJson, reconnect } =
    useWebSocket<unknown>(url, {
      authenticated: true,    // adds ?token= to URL (browser WS can't set headers)
      autoReconnect: true,
      exponentialBackoff: true,

      onOpen: () => {
        // Subscribe to all admin-relevant channels after connection
        for (const channel of ADMIN_CHANNELS) {
          sendJson({ action: "subscribe", channel });
        }
      },

      onMessage: (raw) => {
        let msg: unknown = raw;
        if (typeof msg === "string") {
          try { msg = JSON.parse(msg); } catch { return; }
        }
        if (!msg || typeof msg !== "object") return;

        // Backend envelope: { event: string, data: unknown } or { type: string, ... }
        const envelope = msg as Record<string, unknown>;
        const eventName = (envelope.event ?? envelope.type ?? "") as string;
        const payload   = envelope.data ?? envelope;

        if (!eventName) return;

        // Normalise to portal message type
        const msgType = EVENT_TYPE_MAP[eventName];
        if (!msgType) return;

        switch (msgType) {
          case "system-alert": {
            const message = typeof payload === "object" && payload !== null
              ? ((payload as Record<string, unknown>).message as string) ?? eventName
              : String(payload);
            toast.error(message);
            queryClient.invalidateQueries({ queryKey: ["admin", "alerts"] });
            break;
          }

          case "sos-alert": {
            const d = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
            const message  = (d.message  as string) ?? "New SOS Alert";
            const severity = (d.severity as string) ?? "HIGH";
            const alertId  = (d.alertId  as string) ?? undefined;
            const icon = severity === "HIGH" ? "🚨" : severity === "MEDIUM" ? "⚠️" : "ℹ️";
            toast(message, {
              id: alertId,
              icon,
              style: { background: "#FEF3C7", color: "#92400E" },
            });
            queryClient.invalidateQueries({ queryKey: ["admin", "sos"] });
            break;
          }

          case "stats-update": {
            const d = (typeof payload === "object" && payload !== null ? payload : {}) as Record<string, unknown>;
            queryClient.invalidateQueries({ queryKey: ["admin", "stats"] });
            if (d.module && typeof d.module === "string") {
              queryClient.invalidateQueries({ queryKey: ["admin", "stats", d.module] });
            }
            // Appointment/queue updates also refresh appointment data
            if (eventName === "appointment-updates" || eventName === "queue-updates") {
              queryClient.invalidateQueries({ queryKey: ["admin", "appointments"] });
            }
            break;
          }

          case "activity": {
            queryClient.invalidateQueries({ queryKey: ["admin", "activity"] });
            break;
          }
        }
      },

      onClose: () => { /* silent */ },
      onError: () => { /* silent */ },
    });

  // Convenience: broadcast a message to a channel (admin → backend)
  const broadcast = useCallback(
    (channel: string, data: unknown) => sendJson({ action: "publish", channel, data }),
    [sendJson],
  );

  return { isConnected, connectionState, send, sendJson, broadcast, reconnect };
}
