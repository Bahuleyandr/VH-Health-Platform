// src/hooks/useAdminWebSocket.ts
import { useWebSocket } from "./useWebSocket";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

// Define the message types
interface SystemAlertMessage {
  type: "system-alert";
  message: string;
}

interface SosAlertMessage {
  type: "sos-alert";
  message: string;
  severity?: "HIGH" | "MEDIUM" | "LOW";
  alertId?: string;
}

interface StatsUpdateMessage {
  type: "stats-update";
  module?: string;
  data?: unknown;
}

interface ActivityMessage {
  type: "activity";
  action?: string;
  userId?: string;
  timestamp?: string;
}

// Union type for all possible WebSocket messages
type AdminWebSocketMessage = 
  | SystemAlertMessage
  | SosAlertMessage
  | StatsUpdateMessage
  | ActivityMessage;

// Export the hook function properly
export function useAdminWebSocket() {
  const queryClient = useQueryClient();
  
  const { isConnected, connectionState, send, reconnect } = useWebSocket<AdminWebSocketMessage>(
    `${process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:3001'}/admin`,
    {
      authenticated: true, // Include auth token
      autoReconnect: true,
      exponentialBackoff: true,
      onMessage: (data: AdminWebSocketMessage) => {
        // Handle different message types
        switch (data.type) {
          case "system-alert":
            toast.error(data.message);
            queryClient.invalidateQueries({ queryKey: ["admin", "alerts"] });
            break;
            
          case "sos-alert":
            // Use custom styled toast for warning
            toast(`New SOS Alert: ${data.message}`, {
              icon: '⚠️',
              style: {
                background: '#FEF3C7',
                color: '#92400E',
              },
            });
            queryClient.invalidateQueries({ queryKey: ["admin", "sos"] });
            break;
            
          case "stats-update":
            // Silently update stats
            queryClient.invalidateQueries({ queryKey: ["admin", "stats"] });
            if (data.module) {
              queryClient.invalidateQueries({ queryKey: ["admin", "stats", data.module] });
            }
            break;
            
          case "activity":
            queryClient.invalidateQueries({ queryKey: ["admin", "activity"] });
            break;
        }
      },
      onOpen: () => {
        console.log("Admin WebSocket connected");
      },
      onClose: () => {
        console.log("Admin WebSocket disconnected");
      },
      onError: (error) => {
        console.error("Admin WebSocket error:", error);
      },
    }
  );
  
  return { 
    isConnected, 
    connectionState,
    send,
    reconnect 
  };
}

// Export the message types for use in other components
export type { 
  AdminWebSocketMessage,
  SystemAlertMessage,
  SosAlertMessage,
  StatsUpdateMessage,
  ActivityMessage
};