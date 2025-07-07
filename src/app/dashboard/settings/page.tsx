// src/app/dashboard/settings/page.tsx

import { getSystemSettings } from "@/lib/api";
import { SystemSetting } from "@/lib/types";
import { SettingsListForm } from "./components/SettingsListForm";
import { Suspense } from "react";

export default async function SettingsPage() {
  const response = await getSystemSettings();
  const settings: SystemSetting[] = response.settings;

  return (
    <div>
      <h2 className="text-2xl font-bold mb-4">System Settings</h2>
      <p className="mb-6 text-gray-600">
        Update system-wide configurations. Changes will take effect immediately.
      </p>

      <Suspense fallback={<div>Loading settings...</div>}>
        <SettingsListForm settings={settings} />
      </Suspense>
    </div>
  );
}