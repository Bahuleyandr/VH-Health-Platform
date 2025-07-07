// src/app/dashboard/notifications/page.tsx

import { getNotifications } from "@/lib/api";
import { Notification } from "@/lib/types";
import { SendAnnouncementForm } from "./components/SendAnnouncementForm";
import { NotificationsTable } from "./components/NotificationsTable";
import { Suspense } from "react";

export default async function NotificationsPage() {
  // Fetching from the GET /manage endpoint in adminNotificationRoutes.js
  const response = await getNotifications();
  const notifications: Notification[] = response.notifications; // Assuming API returns { notifications: [...] }

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">Notification Management</h2>
      <SendAnnouncementForm />
      
      <h3 className="text-xl font-semibold mt-8 mb-4">Notification History</h3>
      <Suspense fallback={<div>Loading history...</div>}>
        <NotificationsTable notifications={notifications} />
      </Suspense>
    </div>
  );
}