// src/app/(with-auth)/dashboard/my-leave/page.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/api-config';

interface LeaveRequest {
  id: number;
  type: string;
  start_date: string;
  end_date: string;
  days: number;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  created_at: string;
  reviewed_by?: string;
  review_notes?: string;
}

interface LeaveBalance {
  casual: number;
  sick: number;
  earned: number;
  annual: number;
  [key: string]: number;
}

const STATUS_STYLE: Record<string, string> = {
  PENDING: 'bg-yellow-500/20 text-yellow-400',
  APPROVED: 'bg-green-500/20 text-green-400',
  REJECTED: 'bg-red-500/20 text-red-400',
  CANCELLED: 'bg-gray-500/20 text-gray-400',
};

const LEAVE_TYPES = ['CASUAL', 'SICK', 'EARNED', 'ANNUAL', 'MATERNITY', 'PATERNITY', 'COMPENSATORY'];

export default function MyLeavePage() {
  const [requests, setRequests] = useState<LeaveRequest[]>([]);
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showApply, setShowApply] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [form, setForm] = useState({
    type: 'CASUAL',
    start_date: '',
    end_date: '',
    reason: '',
  });

  const token = typeof window !== 'undefined' ? localStorage.getItem('adminToken') : null;
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [leaveRes, balanceRes] = await Promise.allSettled([
        fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.leave.myLeave}`, { headers }),
        fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.leave.balance}`, { headers }),
      ]);

      if (leaveRes.status === 'fulfilled' && leaveRes.value.ok) {
        const d = await leaveRes.value.json() as { data?: LeaveRequest[]; requests?: LeaveRequest[] } | LeaveRequest[];
        const items = Array.isArray(d) ? d : ((d as { data?: LeaveRequest[] }).data ?? (d as { requests?: LeaveRequest[] }).requests ?? []);
        setRequests(items);
      }
      if (balanceRes.status === 'fulfilled' && balanceRes.value.ok) {
        const d = await balanceRes.value.json() as { data?: LeaveBalance } | LeaveBalance;
        setBalance((d as { data?: LeaveBalance }).data ?? (d as LeaveBalance));
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void fetchData(); }, [fetchData]);

  const applyLeave = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.leave.apply}`, {
        method: 'POST', headers,
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error('Failed to apply for leave');
      setSuccessMsg('Leave application submitted.');
      setShowApply(false);
      setForm({ type: 'CASUAL', start_date: '', end_date: '', reason: '' });
      await fetchData();
    } catch (e) {
      setSuccessMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">My Leave</h1>
        <button
          onClick={() => setShowApply(true)}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
        >
          + Apply for Leave
        </button>
      </div>

      {successMsg && (
        <div className="rounded bg-green-500/10 border border-green-500/30 px-4 py-2 text-sm text-green-400 flex items-center justify-between">
          {successMsg}
          <button className="ml-4 text-xs opacity-60 hover:opacity-100" onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}

      {/* Leave Balance */}
      {balance && (
        <div className="rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold text-white mb-3">Leave Balance</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Object.entries(balance).map(([key, val]) => (
              <div key={key} className="text-center">
                <p className="text-2xl font-bold text-white">{val}</p>
                <p className="text-xs text-muted-foreground capitalize">{key}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Leave Requests */}
      <div className="space-y-3">
        <h2 className="font-semibold text-white">My Requests</h2>
        {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
        {error && <p className="text-red-400 text-sm">{error}</p>}
        {!loading && requests.length === 0 && (
          <p className="text-muted-foreground text-sm">No leave requests found.</p>
        )}
        {requests.map((req) => (
          <div key={req.id} className="rounded-lg border border-border bg-card p-4 space-y-2">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-medium text-white">{req.type} Leave</p>
                <p className="text-sm text-muted-foreground">
                  {req.start_date} → {req.end_date} ({req.days} day{req.days !== 1 ? 's' : ''})
                </p>
                <p className="text-sm text-muted-foreground italic mt-1">{req.reason}</p>
                {req.review_notes && (
                  <p className="text-xs text-muted-foreground mt-1">Note: {req.review_notes}</p>
                )}
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[req.status]}`}>
                {req.status}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Apply Modal */}
      {showApply && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md space-y-4">
            <h2 className="font-semibold text-white">Apply for Leave</h2>
            <div className="space-y-3">
              <label className="block text-sm text-muted-foreground">
                Leave Type
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white">
                  {LEAVE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="block text-sm text-muted-foreground">
                Start Date
                <input type="date" value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
              <label className="block text-sm text-muted-foreground">
                End Date
                <input type="date" value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
              <label className="block text-sm text-muted-foreground">
                Reason
                <textarea value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} rows={3}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowApply(false)} className="rounded bg-muted px-4 py-2 text-sm text-muted-foreground hover:text-white">Cancel</button>
              <button onClick={() => void applyLeave()} disabled={submitting || !form.start_date || !form.end_date || !form.reason}
                className="rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500 disabled:opacity-50">
                Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
