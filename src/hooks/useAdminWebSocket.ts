// src/hooks/useAdminWebSocket.ts
import { useWebSocket } from "./useWebSocket";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

// Message types
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
  data?: unknown; // keep flexible
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

export function useAdminWebSocket() {
  const queryClient = useQueryClient();

  // Normalize base URL and avoid double slashes
  const base = (process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001").replace(/\/+$/, "");
  const url = `${base}/admin`;

  // Allow union with string in case your wrapper forwards raw text sometimes
  const { isConnected, connectionState, send, reconnect } =
    useWebSocket<AdminWebSocketMessage | string>(url, {
      authenticated: true,
      autoReconnect: true,
      exponentialBackoff: true,

      onMessage: (data) => {
        // Be robust to raw JSON strings
        let msg: unknown = data;
        if (typeof msg === "string") {
          try {
            msg = JSON.parse(msg);
          } catch {
            // Not JSON → ignore quietly
            return;
          }
        }
        if (!msg || typeof msg !== "object" || !("type" in msg)) return;

        const m = msg as AdminWebSocketMessage;

        switch (m.type) {
          case "system-alert": {
            toast.error(m.message);
            queryClient.invalidateQueries({ queryKey: ["admin", "alerts"] });
            break;
          }

          case "sos-alert": {
            const s = m as SosAlertMessage;
            const title = `New SOS Alert: ${s.message ?? ""}`.trim() || "New SOS Alert";
            const id = s.alertId ?? undefined;

            // Map severity to icon, keep your yellow styling
            const icon =
              s.severity === "HIGH" ? "🚨" : s.severity === "MEDIUM" ? "⚠️" : "ℹ️";

            toast(title, {
              id,
              icon,
              style: {
                background: "#FEF3C7", // amber-100
                color: "#92400E",      // amber-800
              },
            });

            queryClient.invalidateQueries({ queryKey: ["admin", "sos"] });
            break;
          }

          case "stats-update": {
            const s = m as StatsUpdateMessage;
            // Broad stats refresh
            queryClient.invalidateQueries({ queryKey: ["admin", "stats"] });
            // Narrow module refresh if provided
            if (s.module) {
              queryClient.invalidateQueries({ queryKey: ["admin", "stats", s.module] });
            }
            break;
          }

          case "activity": {
            queryClient.invalidateQueries({ queryKey: ["admin", "activity"] });
            break;
          }
        }
      },

      onOpen: () => {
        // console.debug("Admin WebSocket connected");
      },
      onClose: () => {
        // console.debug("Admin WebSocket disconnected");
      },
      onError: () => {
        // console.error("Admin WebSocket error");
      },
    });

  return {
    isConnected,
    connectionState,
    send,
    reconnect,
  };
}
