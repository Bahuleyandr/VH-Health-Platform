'use client';

// src/app/dashboard/notifications/page.tsx
import { useEffect, useState, Suspense, useCallback } from 'react';
import { fetchAdminAPI } from '@/lib/api';
import type { Notification } from '@/lib/types';
import { SendAnnouncementForm } from './components/SendAnnouncementForm';
import { NotificationsTable } from './components/NotificationsTable';

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function NotificationsContent() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Backend may return an array or an object with { notifications } / { data }
      const resp = await fetchAdminAPI<unknown>('/notifications');

      let list: Notification[] = [];
      if (Array.isArray(resp)) {
        list = resp as Notification[];
      } else if (isObj(resp)) {
        const r = resp as any;
        if (Array.isArray(r.notifications)) list = r.notifications as Notification[];
        else if (Array.isArray(r.data)) list = r.data as Notification[];
      }

      setNotifications(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch notifications');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await fetchNotifications();
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchNotifications]);

  const handleAnnouncementSent = () => {
    // Refresh notifications after sending
    fetchNotifications();
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
