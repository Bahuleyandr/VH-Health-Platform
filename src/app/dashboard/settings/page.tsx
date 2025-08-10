// src/app/dashboard/settings/page.tsx
'use client';

import { useEffect, useState, Suspense } from 'react';
import { fetchAdminAPI } from '@/lib/api';
import type { SystemSetting } from '@/lib/types';
import { SettingsListForm } from './components/SettingsListForm';

function SettingsContent() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function fetchSettings() {
    try {
      setLoading(true);
      setError(null);

      const response = await fetchAdminAPI<{ settings: SystemSetting[] }>(
        '/system/settings',
        { method: 'GET' }
      );

      setSettings(response?.settings ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to fetch settings';
      setError(msg);
      setSettings([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // No eslint-disable needed — deps are intentional
    fetchSettings();
  }, []);

  const handleSettingUpdated = () => {
    fetchSettings();
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded">
        Error: {error}
      </div>
    );
  }

  return <SettingsListForm settings={settings} onUpdate={handleSettingUpdated} />;
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
