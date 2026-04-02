// src/app/(with-auth)/dashboard/reporting/components/DataExporter.tsx
"use client";

import { useState, useMemo } from "react";
import { API_BASE_URL, getHeaders } from "@/lib/api-config";
import { DownloadIcon, RefreshIcon } from "@/components/icons";

/* ─── Date preset helpers ─── */
function today() {
  return new Date().toISOString().split("T")[0];
}
function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000).toISOString().split("T")[0];
}
function startOfMonth(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split("T")[0];
}
function startOfQuarter() {
  const now = new Date();
  const q = Math.floor(now.getMonth() / 3) * 3;
  return new Date(now.getFullYear(), q, 1).toISOString().split("T")[0];
}

interface DatePreset {
  label: string;
  from: string;
  to: string;
}

const DATE_PRESETS: DatePreset[] = [
  { label: "Today", from: today(), to: today() },
  { label: "Last 7 days", from: daysAgo(7), to: today() },
  { label: "Last 30 days", from: daysAgo(30), to: today() },
  { label: "This month", from: startOfMonth(), to: today() },
  {
    label: "Last month",
    from: startOfMonth(new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)),
    to: new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().split("T")[0],
  },
  { label: "This quarter", from: startOfQuarter(), to: today() },
];

/* ─── Export definitions ─── */
interface ExportDef {
  id: string;
  label: string;
  description: string;
  color: string;
  hoverColor: string;
  buildUrl: (from: string, to: string) => string;
  filename: (from: string, to: string) => string;
}

const EXPORTS: ExportDef[] = [
  {
    id: "appointments",
    label: "Appointments CSV",
    description: "All appointments with patient/doctor info, status, and timestamps",
    color: "bg-primary",
    hoverColor: "hover:bg-primary/90",
    buildUrl: (from, to) =>
      `/api/v1/appointments/admin/export?format=csv&startDate=${from}&endDate=${to}`,
    filename: (from, to) => `appointments-${from}-to-${to}.csv`,
  },
  {
    id: "staff",
    label: "Staff HR Report",
    description: "Staff details, attendance, department allocation",
    color: "bg-purple-600",
    hoverColor: "hover:bg-purple-700",
    buildUrl: () => `/api/v1/staff/hr/export-report?format=csv`,
    filename: () => `staff-hr-report-${today()}.csv`,
  },
  {
    id: "departments",
    label: "Departments CSV",
    description: "Department list with doctor counts and status",
    color: "bg-teal-600",
    hoverColor: "hover:bg-teal-700",
    buildUrl: () => `/api/v1/departments/admin/export/csv`,
    filename: () => `departments-${today()}.csv`,
  },
  {
    id: "records-excel",
    label: "Records (Excel)",
    description: "Medical records exported as XLSX spreadsheet",
    color: "bg-success",
    hoverColor: "hover:bg-success/90",
    buildUrl: () => `/api/v1/records/admin/export/excel`,
    filename: () => `medical-records-${today()}.xlsx`,
  },
  {
    id: "records-pdf",
    label: "Records (PDF)",
    description: "Formatted medical records report as PDF",
    color: "bg-destructive",
    hoverColor: "hover:bg-destructive/90",
    buildUrl: () => `/api/v1/records/admin/export/pdf`,
    filename: () => `medical-records-${today()}.pdf`,
  },
];

/* ─── Preview state ─── */
interface PreviewData {
  exportId: string;
  rows: number;
  columns: string[];
  dateRange: { from: string; to: string };
  sampleRows: Record<string, string>[];
}

export function DataExporter() {
  const [dateRange, setDateRange] = useState({ from: daysAgo(30), to: today() });
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);

  const applyPreset = (p: DatePreset) => {
    setDateRange({ from: p.from, to: p.to });
  };

  const activePreset = useMemo(
    () => DATE_PRESETS.find((p) => p.from === dateRange.from && p.to === dateRange.to)?.label ?? null,
    [dateRange],
  );

  const downloadFile = async (exp: ExportDef) => {
    setLoading(exp.id);
    setError(null);
    setPreview(null);

    try {
      // Auth is via httpOnly cookie — no need to pass token explicitly.
      const url = `/api/proxy/${exp.buildUrl(dateRange.from, dateRange.to).replace(/^\/api\/v1\//, '')}`;
      const res = await fetch(url, { credentials: "include" });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Export failed (${res.status})`);
      }

      const blob = await res.blob();

      // Try to parse CSV for preview
      if (exp.id.startsWith("records-pdf") === false && blob.type.includes("csv") || exp.id === "appointments" || exp.id === "staff" || exp.id === "departments") {
        try {
          const text = await blob.text();
          const lines = text.split("\n").filter(Boolean);
          if (lines.length > 0) {
            const columns = lines[0].split(",").map((c) => c.replace(/"/g, "").trim());
            const sampleRows = lines.slice(1, 6).map((line) => {
              const vals = line.split(",").map((v) => v.replace(/"/g, "").trim());
              const row: Record<string, string> = {};
              columns.forEach((col, i) => { row[col] = vals[i] ?? ""; });
              return row;
            });
            setPreview({
              exportId: exp.id,
              rows: lines.length - 1,
              columns,
              dateRange: { ...dateRange },
              sampleRows,
            });
          }
        } catch { /* ignore parse errors, still download */ }
      }

      // Trigger download
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = exp.filename(dateRange.from, dateRange.to);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Date Range */}
      <div className="bg-white p-5 rounded-lg shadow">
        <h3 className="text-lg font-semibold mb-3">Date Range</h3>

        {/* Presets */}
        <div className="flex flex-wrap gap-2 mb-4">
          {DATE_PRESETS.map((p) => (
            <button
              key={p.label}
              onClick={() => applyPreset(p)}
              className={`px-3 py-1.5 text-sm rounded-full border transition-colors ${
                activePreset === p.label
                  ? "bg-primary text-white border-primary"
                  : "bg-white text-foreground border-input hover:border-primary hover:text-primary"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* Manual date inputs */}
        <div className="flex items-center gap-4">
          <div>
            <label htmlFor="exp-from" className="block text-sm font-medium text-foreground mb-1">
              Start Date
            </label>
            <input
              id="exp-from"
              type="date"
              value={dateRange.from}
              onChange={(e) => setDateRange((r) => ({ ...r, from: e.target.value }))}
              className="px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label htmlFor="exp-to" className="block text-sm font-medium text-foreground mb-1">
              End Date
            </label>
            <input
              id="exp-to"
              type="date"
              value={dateRange.to}
              onChange={(e) => setDateRange((r) => ({ ...r, to: e.target.value }))}
              className="px-3 py-2 border border-input rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-destructive/10 border border-destructive/30 text-destructive rounded-lg">{error}</div>
      )}

      {/* Export Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {EXPORTS.map((exp) => (
          <div key={exp.id} className="bg-white rounded-lg shadow p-5 flex flex-col">
            <h4 className="font-semibold text-foreground mb-1">{exp.label}</h4>
            <p className="text-sm text-muted-foreground mb-4 flex-1">{exp.description}</p>
            <button
              onClick={() => downloadFile(exp)}
              disabled={loading !== null}
              className={`w-full py-2 px-4 text-white rounded-md ${exp.color} ${exp.hoverColor} disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2`}
            >
              {loading === exp.id ? (
                <>
                  <RefreshIcon className="animate-spin h-4 w-4" />
                  Exporting…
                </>
              ) : (
                <>
                  <DownloadIcon className="w-4 h-4" />
                  Download
                </>
              )}
            </button>
          </div>
        ))}
      </div>

      {/* Preview Table */}
      {preview && (
        <div className="bg-white rounded-lg shadow p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-lg font-semibold">Export Preview</h3>
            <button onClick={() => setPreview(null)} className="text-sm text-muted-foreground hover:text-foreground">
              Dismiss
            </button>
          </div>
          <div className="mb-3 flex flex-wrap gap-4 text-sm text-muted-foreground">
            <span><strong>Rows:</strong> {preview.rows.toLocaleString()}</span>
            <span><strong>Columns:</strong> {preview.columns.length}</span>
            <span><strong>Range:</strong> {preview.dateRange.from} → {preview.dateRange.to}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted">
                <tr>
                  {preview.columns.map((col) => (
                    <th key={col} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground uppercase">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {preview.sampleRows.map((row, i) => (
                  <tr key={i} className="hover:bg-muted">
                    {preview.columns.map((col) => (
                      <td key={col} className="px-3 py-2 text-foreground whitespace-nowrap max-w-[200px] truncate">
                        {row[col]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.rows > 5 && (
            <p className="mt-2 text-xs text-muted-foreground">Showing first 5 of {preview.rows.toLocaleString()} rows</p>
          )}
        </div>
      )}
    </div>
  );
}
