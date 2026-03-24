// src/app/(with-auth)/dashboard/notifications/page.tsx
"use client";

import { Suspense, useState } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { normalizeList } from "@/lib/normalize-response";
import type { Notification } from "@/lib/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NotificationComposer } from "./components/NotificationComposer";
import { NotificationsTable } from "./components/NotificationsTable";
import { ScheduledNotifications } from "./components/ScheduledNotifications";
import { AnnouncementBannerManager } from "./components/AnnouncementBannerManager";

const normalizeNotifications = normalizeList<Notification>("notifications");

type Tab = "compose" | "history" | "scheduled" | "banner";

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
      const resp = await fetchAdminAPI<unknown>("/notifications");
      return normalizeNotifications(resp);
    },
  });

  const handleNotificationSent = () => {
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
    queryClient.invalidateQueries({ queryKey: ["scheduled-notifications"] });
  };

  const tabs: { key: Tab; label: string; icon: string }[] = [
    { key: "compose", label: "Compose", icon: "✏️" },
    { key: "history", label: "History", icon: "📜" },
    { key: "scheduled", label: "Scheduled", icon: "⏰" },
    { key: "banner", label: "Banner", icon: "📢" },
  ];

  return (
    <>
      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-gray-200 dark:border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2.5 text-sm font-medium rounded-t-lg transition-colors ${
              activeTab === tab.key
                ? "bg-blue-50 text-blue-700 border-b-2 border-blue-600 dark:bg-blue-900/30 dark:text-blue-300"
                : "text-gray-500 hover:text-gray-700 hover:bg-gray-50 dark:text-gray-400 dark:hover:bg-gray-800"
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
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          ) : error ? (
            <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
              Error: {error instanceof Error ? error.message : "Failed to fetch"}
            </div>
          ) : (
            <NotificationsTable notifications={notifications} />
          )}
        </div>
      )}

      {activeTab === "scheduled" && <ScheduledNotifications />}
      {activeTab === "banner" && <AnnouncementBannerManager />}
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
