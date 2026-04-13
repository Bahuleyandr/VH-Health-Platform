// src/app/(with-auth)/dashboard/my-attendance/page.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/api-config';

interface AttendanceRecord {
  date: string;        // YYYY-MM-DD
  status: 'PRESENT' | 'ABSENT' | 'LATE' | 'LEAVE' | 'HALF_DAY';
  check_in?: string;
  check_out?: string;
  notes?: string;
}

const STATUS_STYLES: Record<string, string> = {
  PRESENT:  'bg-green-500 text-white',
  ABSENT:   'bg-red-500 text-white',
  LATE:     'bg-yellow-500 text-black',
  LEAVE:    'bg-blue-500 text-white',
  HALF_DAY: 'bg-orange-400 text-white',
};

function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

export default function MyAttendancePage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showRegularize, setShowRegularize] = useState(false);
  const [showDispute, setShowDispute] = useState(false);
  const [formDate, setFormDate] = useState('');
  const [formReason, setFormReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Auth is carried via the httpOnly auth_token cookie handled by /api/proxy.
  const headers: HeadersInit = { 'Content-Type': 'application/json' };

  const fetchAttendance = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${API_BASE_URL}${API_ENDPOINTS.myWork.attendance.myAttendance}?year=${year}&month=${month + 1}`,
        { headers }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { data?: AttendanceRecord[]; records?: AttendanceRecord[] } | AttendanceRecord[];
      const items = Array.isArray(d)
        ? d
        : ((d as { data?: AttendanceRecord[] }).data ?? (d as { records?: AttendanceRecord[] }).records ?? []);
      setRecords(items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  useEffect(() => { void fetchAttendance(); }, [fetchAttendance]);

  const recordMap = new Map(records.map((r) => [r.date, r]));

  const daysInMonth = getDaysInMonth(year, month);
  const firstDay = getFirstDayOfMonth(year, month);
  const monthLabel = new Date(year, month, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  const handleRegularize = async () => {
    setSubmitting(true);
    try {
      await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.attendance.regularize}`, {
        method: 'POST', headers,
        body: JSON.stringify({ date: formDate, reason: formReason }),
      });
      setSuccessMsg('Regularization request submitted.');
      setShowRegularize(false);
      setFormDate(''); setFormReason('');
    } catch {
      setSuccessMsg('Failed to submit regularization.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDispute = async () => {
    setSubmitting(true);
    try {
      await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.attendance.dispute}`, {
        method: 'POST', headers,
        body: JSON.stringify({ date: formDate, reason: formReason }),
      });
      setSuccessMsg('Dispute raised successfully.');
      setShowDispute(false);
      setFormDate(''); setFormReason('');
    } catch {
      setSuccessMsg('Failed to raise dispute.');
    } finally {
      setSubmitting(false);
    }
  };

  // Summary stats
  const summary = records.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">My Attendance</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowRegularize(true)}
            className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
          >
            + Regularize
          </button>
          <button
            onClick={() => setShowDispute(true)}
            className="rounded bg-orange-600 px-3 py-1.5 text-sm text-white hover:bg-orange-500"
          >
            Raise Dispute
          </button>
        </div>
      </div>

      {successMsg && (
        <div className="rounded bg-green-500/10 border border-green-500/30 px-4 py-2 text-sm text-green-400">
          {successMsg}
          <button className="ml-4 text-xs opacity-60 hover:opacity-100" onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}

      {/* Month Navigator */}
      <div className="flex items-center gap-4">
        <button onClick={prevMonth} className="rounded bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:text-white">‹</button>
        <span className="font-semibold text-white">{monthLabel}</span>
        <button onClick={nextMonth} className="rounded bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:text-white">›</button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-5 gap-3">
        {Object.entries({ PRESENT: 'Present', ABSENT: 'Absent', LATE: 'Late', LEAVE: 'Leave', HALF_DAY: 'Half Day' }).map(([key, label]) => (
          <div key={key} className="rounded-lg border border-border bg-card p-3 text-center">
            <p className="text-2xl font-bold text-white">{summary[key] ?? 0}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {/* Calendar */}
      {loading ? (
        <div className="py-10 text-center text-muted-foreground">Loading…</div>
      ) : (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="grid grid-cols-7 gap-1 text-center text-xs font-medium text-muted-foreground mb-2">
            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
              <div key={d}>{d}</div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: firstDay }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const rec = recordMap.get(dateStr);
              const isToday = dateStr === now.toISOString().slice(0, 10);
              return (
                <div
                  key={day}
                  title={rec ? `${rec.status}${rec.check_in ? ` · In: ${rec.check_in}` : ''}${rec.check_out ? ` · Out: ${rec.check_out}` : ''}` : dateStr}
                  className={`
                    aspect-square flex items-center justify-center rounded text-xs font-medium cursor-default
                    ${isToday ? 'ring-2 ring-indigo-500' : ''}
                    ${rec ? STATUS_STYLES[rec.status] : 'text-muted-foreground'}
                  `}
                >
                  {day}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded bg-red-500/10 border border-red-500/30 px-4 py-2 text-sm text-red-400">{error}</div>
      )}

      {/* Legend */}
      <div className="flex gap-4 flex-wrap text-xs text-muted-foreground">
        {Object.entries(STATUS_STYLES).map(([key, cls]) => (
          <span key={key} className="flex items-center gap-1.5">
            <span className={`inline-block h-3 w-3 rounded-sm ${cls}`} />
            {key.replace('_', ' ')}
          </span>
        ))}
      </div>

      {/* Regularize Modal */}
      {showRegularize && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md space-y-4">
            <h2 className="font-semibold text-white">Regularization Request</h2>
            <div className="space-y-3">
              <label className="block text-sm text-muted-foreground">
                Date
                <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
              <label className="block text-sm text-muted-foreground">
                Reason
                <textarea value={formReason} onChange={e => setFormReason(e.target.value)} rows={3}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowRegularize(false)} className="rounded bg-muted px-4 py-2 text-sm text-muted-foreground hover:text-white">Cancel</button>
              <button onClick={() => void handleRegularize()} disabled={submitting || !formDate || !formReason}
                className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50">
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dispute Modal */}
      {showDispute && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md space-y-4">
            <h2 className="font-semibold text-white">Raise Attendance Dispute</h2>
            <div className="space-y-3">
              <label className="block text-sm text-muted-foreground">
                Date
                <input type="date" value={formDate} onChange={e => setFormDate(e.target.value)}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
              <label className="block text-sm text-muted-foreground">
                Reason for dispute
                <textarea value={formReason} onChange={e => setFormReason(e.target.value)} rows={3}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowDispute(false)} className="rounded bg-muted px-4 py-2 text-sm text-muted-foreground hover:text-white">Cancel</button>
              <button onClick={() => void handleDispute()} disabled={submitting || !formDate || !formReason}
                className="rounded bg-orange-600 px-4 py-2 text-sm text-white hover:bg-orange-500 disabled:opacity-50">
                Raise Dispute
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
