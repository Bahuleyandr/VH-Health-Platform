// src/app/(with-auth)/dashboard/notifications/components/ScheduledNotifications.tsx
"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";

interface ScheduledItem {
  id: string | number;
  title: string;
  message?: string;
  type?: string;
  scheduledAt: string;
  target?: string;
  status?: string;
}

export function ScheduledNotifications() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["scheduled-notifications"],
    queryFn: async () => {
      const resp = await fetchAdminAPI<{
        data?: ScheduledItem[];
        items?: ScheduledItem[];
      }>("/notifications/scheduled/pending");
      return resp?.data ?? resp?.items ?? [];
    },
  });

  const items = data ?? [];

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-32">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded text-sm">
        Error loading scheduled notifications:{" "}
        {error instanceof Error ? error.message : "Unknown error"}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-border dark:border-border bg-card dark:bg-background p-8 text-center">
        <p className="text-3xl mb-2">⏰</p>
        <p className="text-muted-foreground dark:text-muted-foreground">
          No scheduled notifications pending
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border dark:border-border bg-card dark:bg-background overflow-hidden">
      <div className="px-5 py-3 border-b border-border dark:border-border">
        <h3 className="text-lg font-semibold">
          Pending Scheduled Notifications
        </h3>
        <p className="text-sm text-muted-foreground">
          {items.length} notification{items.length !== 1 ? "s" : ""} pending
        </p>
      </div>
      <div className="divide-y divide-border dark:divide-border">
        {items.map((item) => (
          <div
            key={item.id}
            className="px-5 py-3 flex items-center justify-between"
          >
            <div>
              <p className="font-medium text-sm">{item.title}</p>
              {item.message && (
                <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                  {item.message}
                </p>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {item.type && (
                <span
                  className={`px-2 py-0.5 rounded-full font-medium ${
                    item.type === "critical"
                      ? "bg-destructive/10 text-destructive dark:bg-destructive/30 dark:text-destructive/70"
                      : item.type === "warning"
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                        : item.type === "success"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : "bg-primary/10 text-primary dark:bg-primary/30 dark:text-primary/70"
                  }`}
                >
                  {item.type}
                </span>
              )}
              <span>📅 {new Date(item.scheduledAt).toLocaleString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
