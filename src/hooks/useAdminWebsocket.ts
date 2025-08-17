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

export const useAdminWebSocket = () => {
  const queryClient = useQueryClient();
  
  const { isConnected } = useWebSocket<AdminWebSocketMessage>(
    `${process.env.NEXT_PUBLIC_WS_URL}/admin`,
    {
      onMessage: (data: AdminWebSocketMessage) => {
        // Handle different message types
        switch (data.type) {
          case "system-alert":
            toast.error(data.message);
            queryClient.invalidateQueries({ queryKey: ["admin", "alerts"] });
            break;
            
          case "sos-alert":
            toast.warning(`New SOS Alert: ${data.message}`);
            queryClient.invalidateQueries({ queryKey: ["admin", "sos"] });
            break;
            
          case "stats-update":
            // Silently update stats
            queryClient.invalidateQueries({ queryKey: ["admin", "stats"] });
            break;
            
          case "activity":
            queryClient.invalidateQueries({ queryKey: ["admin", "activity"] });
            break;
            
          default:
            // Handle unknown message types
            console.warn("Unknown WebSocket message type:", data);
        }
      },
    }
  );
  
  return { isConnected };
};