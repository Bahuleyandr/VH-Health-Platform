// src/app/(with-auth)/dashboard/my-appointments/page.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/api-config';

interface Appointment {
  id: number;
  patient_name: string;
  patient_phone?: string;
  appointment_date: string;
  appointment_time: string;
  status: 'SCHEDULED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW' | 'PENDING';
  notes?: string;
  doctor_name?: string;
}

type Tab = 'queue' | 'pending';

function statusBadge(status: string) {
  const map: Record<string, string> = {
    SCHEDULED: 'bg-blue-500/20 text-blue-400',
    COMPLETED: 'bg-green-500/20 text-green-400',
    CANCELLED: 'bg-red-500/20 text-red-400',
    NO_SHOW: 'bg-orange-500/20 text-orange-400',
    PENDING: 'bg-yellow-500/20 text-yellow-400',
  };
  return map[status] ?? 'bg-gray-500/20 text-gray-400';
}

export default function MyAppointmentsPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('queue');
  const [queue, setQueue] = useState<Appointment[]>([]);
  const [pending, setPending] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('adminToken') : null;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [queueRes, pendingRes] = await Promise.allSettled([
        fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.appointments.todayQueue}`, { headers }),
        fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.appointments.pending}`, { headers }),
      ]);

      if (queueRes.status === 'fulfilled' && queueRes.value.ok) {
        const d = await queueRes.value.json() as { data?: Appointment[]; appointments?: Appointment[] } | Appointment[];
        const items = Array.isArray(d) ? d : ((d as { data?: Appointment[]; appointments?: Appointment[] }).data ?? (d as { appointments?: Appointment[] }).appointments ?? []);
        setQueue(items);
      }
      if (pendingRes.status === 'fulfilled' && pendingRes.value.ok) {
        const d = await pendingRes.value.json() as { data?: Appointment[]; appointments?: Appointment[] } | Appointment[];
        const items = Array.isArray(d) ? d : ((d as { data?: Appointment[]; appointments?: Appointment[] }).data ?? (d as { appointments?: Appointment[] }).appointments ?? []);
        setPending(items);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const doAction = async (id: number, action: 'confirm' | 'complete' | 'no-show') => {
    setActionLoading(id);
    try {
      const endpoint = action === 'confirm'
        ? API_ENDPOINTS.myWork.appointments.confirm(id)
        : action === 'complete'
        ? API_ENDPOINTS.myWork.appointments.complete(id)
        : API_ENDPOINTS.myWork.appointments.noShow(id);

      await fetch(`${API_BASE_URL}${endpoint}`, { method: 'POST', headers });
      await fetchData();
    } catch {
      // silently refresh
    } finally {
      setActionLoading(null);
    }
  };

  const list = tab === 'queue' ? queue : pending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">My Appointments</h1>
        <button
          onClick={() => void fetchData()}
          className="rounded bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:text-white transition-colors"
        >
          ↻ Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {(['queue', 'pending'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 px-4 text-sm font-medium transition-colors border-b-2 ${
              tab === t
                ? 'border-indigo-500 text-indigo-400'
                : 'border-transparent text-muted-foreground hover:text-white'
            }`}
          >
            {t === 'queue' ? `Today's Queue (${queue.length})` : `Pending (${pending.length})`}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          Loading appointments…
        </div>
      )}

      {error && (
        <div className="rounded bg-red-500/10 border border-red-500/30 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {!loading && !error && list.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">No appointments found.</div>
      )}

      {!loading && list.map((appt) => (
        <div
          key={appt.id}
          className="rounded-lg border border-border bg-card p-4 space-y-3"
        >
          <div className="flex items-start justify-between">
            <div>
              <p className="font-semibold text-white">{appt.patient_name}</p>
              {appt.patient_phone && (
                <p className="text-xs text-muted-foreground">{appt.patient_phone}</p>
              )}
              <p className="text-sm text-muted-foreground mt-1">
                {appt.appointment_date} · {appt.appointment_time}
              </p>
              {appt.notes && (
                <p className="text-xs text-muted-foreground mt-1 italic">{appt.notes}</p>
              )}
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${statusBadge(appt.status)}`}>
              {appt.status}
            </span>
          </div>

          {/* Actions */}
          <div className="flex gap-2 flex-wrap">
            {appt.status === 'PENDING' && (
              <button
                disabled={actionLoading === appt.id}
                onClick={() => void doAction(appt.id, 'confirm')}
                className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                Confirm
              </button>
            )}
            {appt.status === 'SCHEDULED' && (
              <>
                <button
                  disabled={actionLoading === appt.id}
                  onClick={() => void doAction(appt.id, 'complete')}
                  className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
                >
                  Mark Complete
                </button>
                <button
                  disabled={actionLoading === appt.id}
                  onClick={() => void doAction(appt.id, 'no-show')}
                  className="rounded bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-500 disabled:opacity-50"
                >
                  No Show
                </button>
              </>
            )}
            {appt.status === 'COMPLETED' && (
              <button
                onClick={() => router.push(`/dashboard/upload-prescription?appointmentId=${appt.id}`)}
                className="rounded bg-teal-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-teal-500"
              >
                Upload Prescription
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
