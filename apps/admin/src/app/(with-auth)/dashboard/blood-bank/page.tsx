// src/app/(with-auth)/dashboard/blood-bank/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";

type BloodRequest = {
  id: number;
  patient_uid: string;
  blood_group: string;
  units: number;
  status: string;
  cross_match_done?: boolean;
  issued_at?: string;
  transfused_at?: string;
  notes?: string;
  requested_at: string;
};

type InventoryItem = {
  blood_group: string;
  units_available: number;
  last_updated?: string;
};

const STATUS_COLORS: Record<string, string> = {
  PENDING:       "bg-yellow-100 text-yellow-800",
  CROSS_MATCHED: "bg-blue-100 text-blue-800",
  ISSUED:        "bg-orange-100 text-orange-800",
  TRANSFUSED:    "bg-green-100 text-green-800",
  CANCELLED:     "bg-gray-100 text-gray-600",
};

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];

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

function InventoryTab() {
  const [inventory, setInventory] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchAdminAPI<{ data: InventoryItem[] }>("/blood-bank/inventory");
      const data = (r as Record<string, unknown>).data ?? r;
      setInventory(Array.isArray(data) ? data : []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load inventory"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Blood Inventory</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">↻ Refresh</button>
      </div>
      {loading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}
      {!loading && inventory.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">No inventory data</div>
      )}
      {inventory.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {inventory.map(item => (
            <div key={item.blood_group} className={`border rounded-lg p-4 text-center ${item.units_available < 3 ? "border-red-300 bg-red-50" : "border-border bg-card"}`}>
              <p className="text-2xl font-bold text-foreground">{item.blood_group}</p>
              <p className={`text-3xl font-bold mt-1 ${item.units_available < 3 ? "text-red-600" : "text-green-600"}`}>{item.units_available}</p>
              <p className="text-xs text-muted-foreground mt-1">units available</p>
              {item.last_updated && <p className="text-xs text-muted-foreground">{fmtDate(item.last_updated)}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PendingRequestsTab() {
  const [requests, setRequests] = useState<BloodRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchAdminAPI<{ data: BloodRequest[] }>("/blood-bank/pending");
      const data = (r as Record<string, unknown>).data ?? r;
      setRequests(Array.isArray(data) ? data : []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load requests"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const action = async (id: number, endpoint: string) => {
    setActing(id);
    try { await putJSON(`/api/v1/blood-bank/${id}/${endpoint}`, {}); load(); }
    catch (e) { alert(e instanceof Error ? e.message : "Action failed"); }
    finally { setActing(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Pending Requests</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">↻ Refresh</button>
      </div>
      {loading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}
      {!loading && requests.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">No pending requests</div>
      )}
      {requests.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left bg-muted/50">
              <th className="py-2 px-3">ID</th><th className="py-2 px-3">Blood Group</th>
              <th className="py-2 px-3">Units</th><th className="py-2 px-3">Status</th>
              <th className="py-2 px-3">Requested</th><th className="py-2 px-3">Actions</th>
            </tr></thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3 font-mono text-xs">{r.id}</td>
                  <td className="py-2 px-3 font-bold text-red-700">{r.blood_group}</td>
                  <td className="py-2 px-3">{r.units}</td>
                  <td className="py-2 px-3"><StatusBadge status={r.status} /></td>
                  <td className="py-2 px-3">{fmtDate(r.requested_at)}</td>
                  <td className="py-2 px-3 flex gap-1 flex-wrap">
                    {!r.cross_match_done && (
                      <button onClick={() => action(r.id, "cross-match")} disabled={acting === r.id}
                        className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100 disabled:opacity-50">Cross-match</button>
                    )}
                    {r.cross_match_done && r.status !== "ISSUED" && r.status !== "TRANSFUSED" && (
                      <button onClick={() => action(r.id, "issue")} disabled={acting === r.id}
                        className="text-xs bg-orange-50 text-orange-700 px-2 py-1 rounded hover:bg-orange-100 disabled:opacity-50">Issue</button>
                    )}
                    {r.status === "ISSUED" && (
                      <button onClick={() => action(r.id, "transfused")} disabled={acting === r.id}
                        className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded hover:bg-green-100 disabled:opacity-50">Transfused</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewRequestTab() {
  const [form, setForm] = useState({ patient_uid: "", blood_group: "O+", units: 1, notes: "" });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const submit = async () => {
    if (!form.patient_uid) { alert("Patient UID is required"); return; }
    setSaving(true); setSuccess(false);
    try {
      await postJSON("/api/v1/blood-bank/request", form);
      setSuccess(true);
      setForm({ patient_uid: "", blood_group: "O+", units: 1, notes: "" });
    } catch (e) { alert(e instanceof Error ? e.message : "Failed to create request"); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-md space-y-3">
      <h2 className="text-lg font-semibold">New Blood Request</h2>
      {success && <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">Request created.</div>}
      <input placeholder="Patient UID *" value={form.patient_uid} onChange={e => setForm({ ...form, patient_uid: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
      <select value={form.blood_group} onChange={e => setForm({ ...form, blood_group: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm">
        {BLOOD_GROUPS.map(g => <option key={g} value={g}>{g}</option>)}
      </select>
      <input type="number" min={1} placeholder="Units required" value={form.units}
        onChange={e => setForm({ ...form, units: parseInt(e.target.value) || 1 })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
      <textarea rows={2} placeholder="Clinical notes (optional)" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none" />
      <button onClick={submit} disabled={saving}
        className="w-full py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
        {saving ? "Creating..." : "Create Request"}</button>
    </div>
  );
}

function BloodBankContent() {
  const [tab, setTab] = useState<"inventory" | "pending" | "new">("inventory");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Blood Bank</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[{ key: "inventory" as const, label: "🩸 Inventory" }, { key: "pending" as const, label: "📋 Pending Requests" }, { key: "new" as const, label: "+ New Request" }].map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === key ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {label}</button>
        ))}
      </div>
      {tab === "inventory" && <InventoryTab />}
      {tab === "pending" && <PendingRequestsTab />}
      {tab === "new" && <NewRequestTab />}
    </div>
  );
}

export default function BloodBankPage() {
  return <Suspense fallback={<div className="p-6">Loading blood bank...</div>}><BloodBankContent /></Suspense>;
}
