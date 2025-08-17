// src/hooks/useAdminWebSocket.ts
import { useWebSocket } from "./useWebSocket";
import { useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";

export const useAdminWebSocket = () => {
  const queryClient = useQueryClient();
  
  const { isConnected } = useWebSocket(
    `${process.env.NEXT_PUBLIC_WS_URL}/admin`,
    {
      onMessage: (data: any) => {
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
        }
      },
    }
  );
  
  return { isConnected };
};