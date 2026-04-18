// src/app/(with-auth)/dashboard/radiology/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";

type RadiologyOrder = {
  id: number;
  patient_uid: string;
  study_type: string;
  status: string;
  priority?: string;
  result_summary?: string;
  report_url?: string;
  notes?: string;
  ordered_at: string;
  updated_at?: string;
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  IN_PROGRESS: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-gray-100 text-gray-600",
  REPORTED: "bg-teal-100 text-teal-800",
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status?.toUpperCase()] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
  catch { return d; }
}

function WorklistTab() {
  const [orders, setOrders] = useState<RadiologyOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<RadiologyOrder | null>(null);
  const [reportForm, setReportForm] = useState({ result_summary: "", report_url: "" });
  const [saving, setSaving] = useState(false);

  const fetch = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchAdminAPI<{ data: RadiologyOrder[] }>("/radiology/worklist");
      const data = (r as Record<string, unknown>).data ?? r;
      setOrders(Array.isArray(data) ? data : []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load worklist"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  const submitReport = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await putJSON(`/api/v1/radiology/${selected.id}/report`, reportForm);
      setSelected(null);
      fetch();
    } catch (e) { alert(e instanceof Error ? e.message : "Failed to submit report"); }
    finally { setSaving(false); }
  };

  const cancelOrder = async (id: number) => {
    if (!confirm("Cancel this order?")) return;
    try { await putJSON(`/api/v1/radiology/${id}/cancel`, {}); fetch(); }
    catch (e) { alert(e instanceof Error ? e.message : "Failed to cancel"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Radiology Worklist</h2>
        <button onClick={fetch} className="text-sm text-primary hover:underline">↻ Refresh</button>
      </div>
      {loading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}
      {!loading && orders.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">No pending orders</div>
      )}
      {orders.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left bg-muted/50">
              <th className="py-2 px-3">ID</th><th className="py-2 px-3">Study Type</th>
              <th className="py-2 px-3">Status</th><th className="py-2 px-3">Ordered</th>
              <th className="py-2 px-3">Actions</th>
            </tr></thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3 font-mono text-xs">{o.id}</td>
                  <td className="py-2 px-3 font-medium">{o.study_type}</td>
                  <td className="py-2 px-3"><StatusBadge status={o.status} /></td>
                  <td className="py-2 px-3">{fmtDate(o.ordered_at)}</td>
                  <td className="py-2 px-3 flex gap-2">
                    <button onClick={() => { setSelected(o); setReportForm({ result_summary: o.result_summary ?? "", report_url: o.report_url ?? "" }); }}
                      className="text-xs text-primary hover:underline">Report</button>
                    <button onClick={() => cancelOrder(o.id)} className="text-xs text-red-500 hover:underline">Cancel</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between"><h3 className="font-bold">Add Report — #{selected.id}</h3>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600">✕</button></div>
            <textarea rows={3} placeholder="Result summary" value={reportForm.result_summary}
              onChange={e => setReportForm({ ...reportForm, result_summary: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none" />
            <input placeholder="Report URL (optional)" value={reportForm.report_url}
              onChange={e => setReportForm({ ...reportForm, report_url: e.target.value })}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm" />
            <div className="flex gap-2">
              <button onClick={() => setSelected(null)} className="flex-1 py-2 border rounded-lg text-sm">Cancel</button>
              <button onClick={submitReport} disabled={saving}
                className="flex-1 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50">
                {saving ? "Saving..." : "Submit Report"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewOrderTab() {
  const [form, setForm] = useState({ patient_uid: "", study_type: "", priority: "NORMAL", notes: "" });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const submit = async () => {
    if (!form.patient_uid || !form.study_type) { alert("Patient UID and study type are required"); return; }
    setSaving(true); setSuccess(false);
    try {
      await postJSON("/api/v1/radiology/orders", form);
      setSuccess(true);
      setForm({ patient_uid: "", study_type: "", priority: "NORMAL", notes: "" });
    } catch (e) { alert(e instanceof Error ? e.message : "Failed to create order"); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-md space-y-3">
      <h2 className="text-lg font-semibold">New Radiology Order</h2>
      {success && <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">Order created successfully.</div>}
      <input placeholder="Patient UID *" value={form.patient_uid} onChange={e => setForm({ ...form, patient_uid: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
      <input placeholder="Study type (e.g. X-RAY, CT, MRI) *" value={form.study_type} onChange={e => setForm({ ...form, study_type: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
      <select value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm">
        {["NORMAL", "HIGH", "URGENT", "STAT"].map(p => <option key={p} value={p}>{p}</option>)}
      </select>
      <textarea rows={2} placeholder="Notes (optional)" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none" />
      <button onClick={submit} disabled={saving}
        className="w-full py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
        {saving ? "Creating..." : "Create Order"}</button>
    </div>
  );
}

function RadiologyContent() {
  const [tab, setTab] = useState<"worklist" | "new">("worklist");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Radiology</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[{ key: "worklist" as const, label: "🔬 Worklist" }, { key: "new" as const, label: "+ New Order" }].map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === key ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {label}</button>
        ))}
      </div>
      {tab === "worklist" && <WorklistTab />}
      {tab === "new" && <NewOrderTab />}
    </div>
  );
}

export default function RadiologyPage() {
  return <Suspense fallback={<div className="p-6">Loading radiology...</div>}><RadiologyContent /></Suspense>;
}
