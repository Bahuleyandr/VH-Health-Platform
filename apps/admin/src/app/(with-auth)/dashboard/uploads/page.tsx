// src/app/(with-auth)/dashboard/uploads/page.tsx
//
// Admin file-management dashboard. Reads three upload endpoints:
//   - getUploadSummary        → totals + 7-day trend
//   - listQuarantinedFiles    → files flagged by antivirus / magic-bytes check
//   - getHipaaAuditReport     → HIPAA PHI-access log slice
//
// Replaces the earlier raw-JSON dumps with stat tiles + tables. Cleanup
// buttons still work via adminService — they post dry-run by default so the
// UI won't surprise-delete anything.
"use client";

import { useCallback, useEffect, useState } from "react";
import { adminService } from "@/services/admin.service";

type Summary = {
  totalFiles?: number;
  totalSizeBytes?: number;
  hipaaProtected?: number;
  quarantined?: number;
  expired?: number;
  last7Days?: { date: string; count: number }[];
};

type QuarantinedFile = {
  id?: number | string;
  file_name?: string;
  reason?: string;
  uploaded_by?: string;
  quarantined_at?: string;
  size_bytes?: number;
};

type AuditEntry = {
  id?: number | string;
  actor?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  created_at?: string;
};

function unwrap<T>(x: unknown): T | null {
  if (x && typeof x === "object" && "data" in x) {
    return ((x as { data: unknown }).data as T) ?? null;
  }
  return (x as T) ?? null;
}

function fmtBytes(n?: number) {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("en-IN", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function stableRowKey(prefix: string, value: unknown, index: number) {
  const text = value == null ? "" : String(value).trim();
  return text ? `${prefix}-${text}` : `${prefix}-${index}`;
}

export default function UploadsPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [quarantine, setQuarantine] = useState<QuarantinedFile[]>([]);
  const [hipaa, setHipaa] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, q, h] = await Promise.all([
        adminService.getUploadSummary(),
        adminService.listQuarantinedFiles({ limit: 20, offset: 0 }),
        adminService.getHipaaAuditReport({ limit: 20, offset: 0 }),
      ]);
      setSummary(unwrap<Summary>(s) ?? {});
      const qp = unwrap<QuarantinedFile[] | { items?: QuarantinedFile[] }>(q);
      setQuarantine(Array.isArray(qp) ? qp : (qp && "items" in qp ? qp.items ?? [] : []));
      const hp = unwrap<AuditEntry[] | { items?: AuditEntry[] }>(h);
      setHipaa(Array.isArray(hp) ? hp : (hp && "items" in hp ? hp.items ?? [] : []));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const cleanup = useCallback(async (action: "cleanup" | "purge") => {
    setRunning(action);
    setActionMsg(null);
    try {
      if (action === "cleanup") await adminService.cleanupExpiredFiles(true);
      else await adminService.purgeQuarantinedFiles(true);
      setActionMsg(`${action === "cleanup" ? "Cleanup" : "Purge"} dry run complete.`);
      await refresh();
    } catch (e) {
      setActionMsg(e instanceof Error ? `${action} failed: ${e.message}` : `${action} failed`);
    } finally {
      setRunning(null);
    }
  }, [refresh]);

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-end justify-between">
        <h1 className="text-2xl font-bold text-white">Uploads / File management</h1>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-xs text-white hover:border-indigo-500 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatTile label="Total files" value={summary?.totalFiles ?? 0} />
        <StatTile label="Total size" value={fmtBytes(summary?.totalSizeBytes)} />
        <StatTile label="HIPAA protected" value={summary?.hipaaProtected ?? 0} tone="emerald" />
        <StatTile label="Quarantined" value={summary?.quarantined ?? 0} tone={(summary?.quarantined ?? 0) > 0 ? "red" : "white"} />
        <StatTile label="Expired" value={summary?.expired ?? 0} tone={(summary?.expired ?? 0) > 0 ? "amber" : "white"} />
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Trailing 7 days</h2>
        {(summary?.last7Days ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">No uploads in the last 7 days.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr><Th>Date</Th><Th>Uploads</Th></tr>
            </thead>
            <tbody>
              {(summary?.last7Days ?? []).map((d) => (
                <tr key={d.date} className="border-t border-border">
                  <Td>{d.date}</Td>
                  <Td>{d.count}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">Quarantined files</h2>
        {quarantine.length === 0 ? (
          <p className="text-sm text-muted-foreground">No quarantined files.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr><Th>When</Th><Th>File</Th><Th>Reason</Th><Th>Uploaded by</Th><Th>Size</Th></tr>
            </thead>
            <tbody>
              {quarantine.map((f, index) => (
                <tr key={stableRowKey("quarantine", f.id ?? f.file_name ?? f.quarantined_at, index)} className="border-t border-border">
                  <Td>{fmtDate(f.quarantined_at)}</Td>
                  <Td>{f.file_name ?? "—"}</Td>
                  <Td>{f.reason ?? "—"}</Td>
                  <Td>{f.uploaded_by ?? "—"}</Td>
                  <Td>{fmtBytes(f.size_bytes)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <h2 className="mb-3 font-semibold text-white">HIPAA audit (recent)</h2>
        {hipaa.length === 0 ? (
          <p className="text-sm text-muted-foreground">No audit entries in window.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr><Th>When</Th><Th>Actor</Th><Th>Action</Th><Th>Resource</Th></tr>
            </thead>
            <tbody>
              {hipaa.map((e, index) => (
                <tr key={stableRowKey("hipaa", e.id ?? e.created_at ?? e.resource_id, index)} className="border-t border-border">
                  <Td>{fmtDate(e.created_at)}</Td>
                  <Td>{e.actor ?? "—"}</Td>
                  <Td>{e.action ?? "—"}</Td>
                  <Td>{e.resource_type ? `${e.resource_type}${e.resource_id ? `:${e.resource_id}` : ""}` : "—"}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <h2 className="font-semibold text-white">Maintenance (dry run)</h2>
        <div className="flex gap-3">
          <button
            onClick={() => void cleanup("cleanup")}
            disabled={running !== null}
            className="rounded border border-border bg-card px-4 py-2 text-sm text-white hover:border-indigo-500 disabled:opacity-50"
          >
            {running === "cleanup" ? "Cleaning…" : "Cleanup expired files"}
          </button>
          <button
            onClick={() => void cleanup("purge")}
            disabled={running !== null}
            className="rounded border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-400 hover:bg-red-500/20 disabled:opacity-50"
          >
            {running === "purge" ? "Purging…" : "Purge quarantined"}
          </button>
        </div>
        {actionMsg && <p className="text-xs text-muted-foreground">{actionMsg}</p>}
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string | number; tone?: "amber" | "red" | "emerald" | "white" }) {
  const colour =
    tone === "red" ? "text-red-400"
    : tone === "amber" ? "text-amber-400"
    : tone === "emerald" ? "text-emerald-400"
    : "text-white";
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${colour}`}>{value}</p>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-4 py-2 text-left font-medium">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-4 py-2 text-white/90">{children}</td>;
}
