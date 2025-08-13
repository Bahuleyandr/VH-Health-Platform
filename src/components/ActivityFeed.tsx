// src/components/ActivityFeed.tsx
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";

type Activity = {
  id: string | number;
  description: string;
  timestamp: string | number | Date;
};

async function getRecentActivities() {
  // Adjust the path if your backend differs
  return fetchAdminAPI<Activity[]>("/admin/activities/recent", {
    method: "GET",
  });
}

function formatRelativeTime(input: string | number | Date) {
  const date = new Date(input).getTime();
  const now = Date.now();
  const diffSec = Math.round((date - now) / 1000); // negative if in the past

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const abs = Math.abs(diffSec);

  if (abs < 60) return rtf.format(diffSec, "second");
  const diffMin = Math.round(diffSec / 60);
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, "hour");
  const diffDay = Math.round(diffHr / 24);
  if (Math.abs(diffDay) < 7) return rtf.format(diffDay, "day");
  const diffWeek = Math.round(diffDay / 7);
  if (Math.abs(diffWeek) < 5) return rtf.format(diffWeek, "week");
  const diffMonth = Math.round(diffDay / 30);
  if (Math.abs(diffMonth) < 12) return rtf.format(diffMonth, "month");
  const diffYear = Math.round(diffDay / 365);
  return rtf.format(diffYear, "year");
}

export function ActivityFeed() {
  const { data: activities } = useQuery({
    queryKey: ["activities"],
    queryFn: getRecentActivities,
    refetchInterval: 10_000, // 10s
  });

  return (
    <div className="bg-white rounded-lg shadow p-4">
      <h3 className="font-semibold mb-4">Recent Activity</h3>
      <div className="space-y-3 max-h-96 overflow-y-auto">
        {activities?.length ? (
          activities.map((activity: Activity) => (
            <div key={activity.id} className="flex items-start gap-3">
              <div className="w-2 h-2 bg-blue-500 rounded-full mt-1.5" />
              <div className="flex-1">
                <p className="text-sm">{activity.description}</p>
                <p className="text-xs text-gray-500">
                  {formatRelativeTime(activity.timestamp)}
                </p>
              </div>
            </div>
          ))
        ) : (
          <p className="text-sm text-gray-500">No recent activity.</p>
        )}
      </div>
    </div>
  );
}
