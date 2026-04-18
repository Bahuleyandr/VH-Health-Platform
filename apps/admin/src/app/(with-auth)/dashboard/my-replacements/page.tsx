// src/app/(with-auth)/dashboard/my-replacements/page.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/api-config';

interface ReplacementRequest {
  id: number;
  date: string;
  shift: string;
  reason: string;
  requested_staff?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'COMPLETED';
  created_at: string;
  notes?: string;
}

const STATUS_STYLE: Record<string, string> = {
  PENDING:   'bg-yellow-500/20 text-yellow-400',
  APPROVED:  'bg-green-500/20 text-green-400',
  REJECTED:  'bg-red-500/20 text-red-400',
  COMPLETED: 'bg-blue-500/20 text-blue-400',
};

export default function MyReplacementsPage() {
  const [requests, setRequests] = useState<ReplacementRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [form, setForm] = useState({
    date: '',
    shift: 'MORNING',
    reason: '',
    requested_staff: '',
  });

  // Auth is carried via the httpOnly auth_token cookie handled by /api/proxy.
  const headers: HeadersInit = { 'Content-Type': 'application/json' };

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.replacements.list}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { data?: ReplacementRequest[]; requests?: ReplacementRequest[] } | ReplacementRequest[];
      const items = Array.isArray(d) ? d : ((d as { data?: ReplacementRequest[] }).data ?? (d as { requests?: ReplacementRequest[] }).requests ?? []);
      setRequests(items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void fetchRequests(); }, [fetchRequests]);

  const createRequest = async () => {
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.replacements.create}`, {
        method: 'POST', headers,
        body: JSON.stringify(form),
      });
      if (!res.ok) throw new Error('Failed to create request');
      setSuccessMsg('Replacement request submitted.');
      setShowCreate(false);
      setForm({ date: '', shift: 'MORNING', reason: '', requested_staff: '' });
      await fetchRequests();
    } catch (e) {
      setSuccessMsg(`Error: ${(e as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">My Replacements</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
        >
          + New Request
        </button>
      </div>

      {successMsg && (
        <div className="rounded bg-green-500/10 border border-green-500/30 px-4 py-2 text-sm text-green-400 flex items-center justify-between">
          {successMsg}
          <button className="ml-4 text-xs opacity-60 hover:opacity-100" onClick={() => setSuccessMsg(null)}>✕</button>
        </div>
      )}

      {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
      {error && <p className="text-red-400 text-sm">{error}</p>}
      {!loading && requests.length === 0 && (
        <p className="text-muted-foreground text-sm text-center py-8">No replacement requests found.</p>
      )}

      <div className="space-y-3">
        {requests.map((req) => (
          <div key={req.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-start justify-between">
              <div>
                <p className="font-semibold text-white">{req.date} · {req.shift} Shift</p>
                {req.requested_staff && (
                  <p className="text-sm text-muted-foreground">Requested replacement: {req.requested_staff}</p>
                )}
                <p className="text-sm text-muted-foreground italic mt-1">{req.reason}</p>
                {req.notes && <p className="text-xs text-muted-foreground mt-1">Note: {req.notes}</p>}
              </div>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[req.status] ?? 'bg-gray-500/20 text-gray-400'}`}>
                {req.status}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="rounded-xl border border-border bg-card p-6 w-full max-w-md space-y-4">
            <h2 className="font-semibold text-white">New Replacement Request</h2>
            <div className="space-y-3">
              <label className="block text-sm text-muted-foreground">
                Date
                <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
              <label className="block text-sm text-muted-foreground">
                Shift
                <select value={form.shift} onChange={e => setForm(f => ({ ...f, shift: e.target.value }))}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white">
                  {['MORNING', 'AFTERNOON', 'EVENING', 'NIGHT'].map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="block text-sm text-muted-foreground">
                Preferred Replacement (optional)
                <input type="text" value={form.requested_staff} onChange={e => setForm(f => ({ ...f, requested_staff: e.target.value }))}
                  placeholder="Name or employee ID"
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
              <label className="block text-sm text-muted-foreground">
                Reason
                <textarea value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} rows={3}
                  className="mt-1 block w-full rounded border border-border bg-background px-3 py-2 text-sm text-white" />
              </label>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setShowCreate(false)} className="rounded bg-muted px-4 py-2 text-sm text-muted-foreground hover:text-white">Cancel</button>
              <button onClick={() => void createRequest()} disabled={submitting || !form.date || !form.reason}
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
