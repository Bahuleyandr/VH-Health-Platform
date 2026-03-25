// src/components/SystemAlerts.tsx
"use client";

import { useEffect, useState } from "react";
import { adminService } from "@/services/admin.service";

interface Alert {
  type: "warning" | "error" | "info";
  message: string;
  priority: "high" | "medium" | "low" | "urgent";
  action?: string;
}

export function SystemAlerts() {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAlerts();
    // Refresh alerts every 5 minutes
    const interval = setInterval(fetchAlerts, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const fetchAlerts = async () => {
    try {
      const response = await adminService.getSystemAlerts();
      setAlerts(response.data);
    } catch (error) {
      console.error("Failed to fetch alerts:", error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading alerts...</div>;
  if (alerts.length === 0) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">System Alerts</h2>
      {alerts.map((alert, index) => (
        <AlertItem key={index} alert={alert} />
      ))}
    </div>
  );
}

function AlertItem({ alert }: { alert: Alert }) {
  const bgColor = {
    error: "bg-destructive/10 border-destructive/30",
    warning: "bg-warning/10 border-warning/30",
    info: "bg-primary/10 border-primary/20",
  }[alert.type];

  return (
    <div className={`p-4 rounded-lg border ${bgColor}`}>
      <p className="font-medium">{alert.message}</p>
      {alert.action && (
        <a
          href={alert.action}
          className="text-sm text-primary hover:underline"
        >
          View Details →
        </a>
      )}
    </div>
  );
}
