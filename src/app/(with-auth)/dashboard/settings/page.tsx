// src/app/(with-auth)/dashboard/settings/page.tsx
"use client";

import { Suspense } from "react";
import { fetchAdminAPI } from "@/lib/api";
import type { SystemSetting } from "@/lib/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsListForm } from "./components/SettingsListForm";

function SettingsContent() {
  const queryClient = useQueryClient();

  const {
    data: settings = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["system-settings"],
    queryFn: async () => {
      const response = await fetchAdminAPI<{ settings: SystemSetting[] }>(
        "/system/settings",
        { method: "GET" },
      );
      return response?.settings ?? [];
    },
  });

  const handleSettingUpdated = () => {
    queryClient.invalidateQueries({ queryKey: ["system-settings"] });
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
        Error: {error instanceof Error ? error.message : "Failed to fetch settings"}
      </div>
    );
  }

  return (
    <SettingsListForm settings={settings} onUpdate={handleSettingUpdated} />
  );
}

export default function SettingsPage() {
  return (
    <div className="p-6">
      <h2 className="text-2xl font-bold mb-4">System Settings</h2>
      <p className="mb-6 text-gray-600">
        Update system-wide configurations. Changes will take effect immediately.
      </p>

      <Suspense fallback={<div>Loading settings...</div>}>
        <SettingsContent />
      </Suspense>
    </div>
  );
}
