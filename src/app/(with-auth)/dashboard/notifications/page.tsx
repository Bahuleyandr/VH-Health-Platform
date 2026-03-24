// src/app/(with-auth)/dashboard/notifications/page.tsx
"use client";

import { Suspense } from "react";
import { fetchAdminAPI } from "@/lib/api";
import { normalizeList } from "@/lib/normalize-response";
import type { Notification } from "@/lib/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SendAnnouncementForm } from "./components/SendAnnouncementForm";
import { NotificationsTable } from "./components/NotificationsTable";

const normalizeNotifications = normalizeList<Notification>("notifications");

function NotificationsContent() {
  const queryClient = useQueryClient();

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

  const handleAnnouncementSent = () => {
    queryClient.invalidateQueries({ queryKey: ["notifications"] });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        Error: {error instanceof Error ? error.message : "Failed to fetch notifications"}
      </div>
    );
  }

  return (
    <>
      <SendAnnouncementForm onSuccess={handleAnnouncementSent} />

      <h3 className="text-xl font-semibold mt-8 mb-4">Notification History</h3>
      <NotificationsTable notifications={notifications} />
    </>
  );
}

export default function NotificationsPage() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">Notification Management</h2>
      <Suspense fallback={<div>Loading...</div>}>
        <NotificationsContent />
      </Suspense>
    </div>
  );
}
