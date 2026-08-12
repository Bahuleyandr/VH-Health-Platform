// src/app/(with-auth)/dashboard/notifications/page.tsx
"use client";

import { fetchAdminAPI } from "@/lib/api";
import { normalizeList } from "@/lib/normalize-response";
import type { Notification } from "@/lib/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Suspense, useState } from "react";

import { AnnouncementBannerManager } from "./components/AnnouncementBannerManager";
import { NotificationComposer } from "./components/NotificationComposer";
import { NotificationOutboxConsole } from "./components/NotificationOutboxConsole";
import { NotificationsTable } from "./components/NotificationsTable";
import { ScheduledNotifications } from "./components/ScheduledNotifications";

const normalizeNotifications = normalizeList<Notification>("notifications");

type Tab = "compose" | "history" | "activity" | "scheduled" | "banner" | "delivery";

type NotificationEvent = {
  id: number;
  notification_id: number;
  event_type: string;
  actor_uid?: string | null;
  actor_role?: string | null;
  notification_type?: string | null;
  notification_priority?: string | null;
  related_id?: number | null;
  title?: string | null;
  message?: string | null;
  recipient_name?: string | null;
  recipient_role?: string | null;
  created_at: string;
};

function unwrap<T>(value: unknown): T {
  return ((value as { data?: T }).data ?? value) as T;
}

function eventLabel(value: string | null | undefined) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function NotificationsContent() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<Tab>("compose");

  const {
    data: notifications = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => {
      // Admin history list: /api/v1/notifications/admin/manage.
      // Previously called "/notifications" which resolves to a user-
      // scoped endpoint that doesn't exist — always returned empty.
      const resp = await fetchAdminAPI<unknown>("/notifications/admin/manage");
      return normalizeNotifications(resp);
    },
  });

  const {
    data: notificationEvents = [],
    isLoading: eventsLoading,
    error: eventsError,
  } = useQuery({
    queryKey: ["notifications", "events"],
    queryFn: async () => {
      const resp = await fetchAdminAPI<unknown>(
        "/notifications/admin/events?limit=100",
      );
      const data = unwrap<{ events?: NotificationEvent[] }>(resp);
      return Array.isArray(data.events) ? data.events : [];
    },
  });

  const handleNotificationSent = () => {
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["notifications", "events"] });
    queryClient.invalidateQueries({ queryKey: ["scheduled-notifications"] });
  };

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: "compose", label: "Compose", icon: "✏️" },
    { key: "history", label: "History", icon: "📜" },
    { key: "activity", label: "Activity", icon: "✓" },
    { key: "scheduled", label: "Scheduled", icon: "⏰" },
    { key: "banner", label: "Banner", icon: "📢" },
    { key: "delivery", label: "Delivery Health", icon: "⚕" },
  ];

  return (
    <>
      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-border dark:border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? "bg-primary/10 text-primary border-b-2 border-primary dark:bg-primary/30 dark:text-primary/70"
                : "text-muted-foreground hover:text-foreground hover:bg-muted dark:text-muted-foreground dark:hover:bg-muted"
            }`}
          >
            <span className="mr-1.5">{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === "compose" && (
        <NotificationComposer onSuccess={handleNotificationSent} />
      )}

      {activeTab === "history" && (
        <div>
          <h3 className="text-lg font-semibold mb-4">Notification History</h3>
          {isLoading ? (
            <div className="flex justify-center items-center h-32">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : error ? (
            <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded">
              Error: {error instanceof Error ? error.message : "Failed to fetch"}
            </div>
          ) : (
            <NotificationsTable notifications={notifications} />
          )}
        </div>
      )}

      {activeTab === "activity" && (
        <div>
          <h3 className="text-lg font-semibold mb-4">
            Alert Read / Ack / Escalation Activity
          </h3>
          {eventsLoading ? (
            <div className="flex justify-center items-center h-32">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            </div>
          ) : eventsError ? (
            <div className="bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded">
              Error:{" "}
              {eventsError instanceof Error
                ? eventsError.message
                : "Failed to fetch"}
            </div>
          ) : (
            <NotificationActivityTable events={notificationEvents} />
          )}
        </div>
      )}

      {activeTab === "scheduled" && <ScheduledNotifications />}
      {activeTab === "banner" && <AnnouncementBannerManager />}
      {activeTab === "delivery" && <NotificationOutboxConsole />}
    </>
  );
}

export default function NotificationsPage() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-6">Notification Management</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <NotificationsContent />
      </Suspense>
    </div>
  );
}

function NotificationActivityTable({ events }: { events: NotificationEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No notification read, acknowledge, or escalation activity yet.
      </div>
    );
  }

  return (
    <div className="bg-card shadow rounded-lg overflow-hidden border border-border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] divide-y divide-border">
          <thead className="bg-muted">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                When
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                Event
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                Alert
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                Priority
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                Actor
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-muted-foreground">
                Recipient
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {events.map((event) => (
              <tr key={event.id} className="hover:bg-muted/40">
                <td className="px-4 py-3 whitespace-nowrap text-sm text-muted-foreground">
                  {new Date(event.created_at).toLocaleString("en-GB")}
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm font-medium">
                  {eventLabel(event.event_type)}
                </td>
                <td className="px-4 py-3 text-sm">
                  <div className="font-medium text-foreground">
                    {event.title || `Notification #${event.notification_id}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {eventLabel(event.notification_type)}{" "}
                    {event.related_id ? `#${event.related_id}` : ""}
                  </div>
                </td>
                <td className="px-4 py-3 whitespace-nowrap text-sm">
                  <span className="rounded-full bg-muted px-2 py-1 text-xs font-semibold">
                    {event.notification_priority || "—"}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">
                  {event.actor_role || "System"}
                  {event.actor_uid && (
                    <div className="text-xs text-muted-foreground">
                      {event.actor_uid}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-sm">
                  {event.recipient_name || "—"}
                  {event.recipient_role && (
                    <div className="text-xs text-muted-foreground">
                      {event.recipient_role}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
