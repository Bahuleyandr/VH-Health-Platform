// src/app/(with-auth)/dashboard/my-payslips/page.tsx
'use client';

import { useCallback, useEffect, useState } from 'react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/api-config';

interface Payslip {
  id: string;
  month: string;        // e.g. "January 2025"
  period: string;       // e.g. "2025-01"
  net_pay: number;
  gross_pay: number;
  deductions: number;
  status: 'GENERATED' | 'PAID' | 'PENDING';
  generated_at?: string;
}

const STATUS_STYLE: Record<string, string> = {
  GENERATED: 'bg-blue-500/20 text-blue-400',
  PAID:      'bg-green-500/20 text-green-400',
  PENDING:   'bg-yellow-500/20 text-yellow-400',
};

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount);
}

export default function MyPayslipsPage() {
  const [payslips, setPayslips] = useState<Payslip[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  // Auth is carried via the httpOnly auth_token cookie handled by /api/proxy.
  const headers: HeadersInit = { 'Content-Type': 'application/json' };

  const fetchPayslips = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.payslips.list}`, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as { data?: Payslip[]; payslips?: Payslip[] } | Payslip[];
      const items = Array.isArray(d)
        ? d
        : ((d as { data?: Payslip[] }).data ?? (d as { payslips?: Payslip[] }).payslips ?? []);
      setPayslips(items);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { void fetchPayslips(); }, [fetchPayslips]);

  const downloadPayslip = async (id: string) => {
    setDownloading(id);
    try {
      const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.myWork.payslips.download(id)}`, { headers });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payslip-${id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      alert('Download failed. Please try again.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-white">My Payslips</h1>
        <a
          href={`${API_BASE_URL}${API_ENDPOINTS.myWork.payslips.taxSummary}`}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded bg-muted px-3 py-1.5 text-sm text-muted-foreground hover:text-white transition-colors"
        >
          Annual Tax Summary ↗
        </a>
      </div>

      {loading && <p className="text-muted-foreground text-sm">Loading payslips…</p>}
      {error && (
        <div className="rounded bg-red-500/10 border border-red-500/30 px-4 py-2 text-sm text-red-400">{error}</div>
      )}

      {!loading && payslips.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">No payslips found.</div>
      )}

      <div className="space-y-3">
        {payslips.map((p) => (
          <div key={p.id} className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-white">{p.month ?? p.period}</p>
                <p className="text-sm text-muted-foreground">
                  Gross: {formatCurrency(p.gross_pay)} · Deductions: {formatCurrency(p.deductions)}
                </p>
                <p className="text-base font-bold text-green-400 mt-1">
                  Net: {formatCurrency(p.net_pay)}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2">
                <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[p.status] ?? 'bg-gray-500/20 text-gray-400'}`}>
                  {p.status}
                </span>
                <button
                  disabled={downloading === p.id}
                  onClick={() => void downloadPayslip(p.id)}
                  className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  {downloading === p.id ? 'Downloading…' : '↓ PDF'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
