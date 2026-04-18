// src/app/(with-auth)/dashboard/theatre/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON, deleteJSON } from "@/lib/api";

type TheatreSchedule = {
  id: number;
  patient_uid: string;
  procedure_name: string;
  surgeon_uid: string;
  status: string;
  theatre_number?: string;
  scheduled_at?: string;
  checklist?: Record<string, boolean>;
  notes?: string;
  created_at: string;
};

type TheatreAvailability = {
  theatre_number: string;
  date: string;
  slots: string[];
};

const STATUS_COLORS: Record<string, string> = {
  SCHEDULED:   "bg-blue-100 text-blue-800",
  IN_PROGRESS: "bg-orange-100 text-orange-800",
  COMPLETED:   "bg-green-100 text-green-800",
  CANCELLED:   "bg-gray-100 text-gray-600",
  POSTPONED:   "bg-yellow-100 text-yellow-800",
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
  try { return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
  catch { return d; }
}

function TodayTab() {
  const [schedules, setSchedules] = useState<TheatreSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchAdminAPI<{ data: TheatreSchedule[] }>("/theatre/today");
      const data = (r as Record<string, unknown>).data ?? r;
      setSchedules(Array.isArray(data) ? data : []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load theatre schedule"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateStatus = async (id: number, status: string) => {
    setUpdating(id);
    try { await putJSON(`/api/v1/theatre/${id}/status`, { status }); load(); }
    catch (e) { alert(e instanceof Error ? e.message : "Failed to update status"); }
    finally { setUpdating(null); }
  };

  const cancel = async (id: number) => {
    if (!confirm("Cancel this theatre booking?")) return;
    try { await deleteJSON(`/api/v1/theatre/${id}`); load(); }
    catch (e) { alert(e instanceof Error ? e.message : "Failed to cancel"); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Today&apos;s Theatre Schedule</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">↻ Refresh</button>
      </div>
      {loading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}
      {!loading && schedules.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">No procedures scheduled for today</div>
      )}
      {schedules.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border text-left bg-muted/50">
              <th className="py-2 px-3">ID</th><th className="py-2 px-3">Procedure</th>
              <th className="py-2 px-3">Theatre</th><th className="py-2 px-3">Scheduled</th>
              <th className="py-2 px-3">Status</th><th className="py-2 px-3">Actions</th>
            </tr></thead>
            <tbody>
              {schedules.map(s => (
                <tr key={s.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3 font-mono text-xs">{s.id}</td>
                  <td className="py-2 px-3 font-medium">{s.procedure_name}</td>
                  <td className="py-2 px-3">{s.theatre_number ?? "—"}</td>
                  <td className="py-2 px-3">{fmtDate(s.scheduled_at)}</td>
                  <td className="py-2 px-3"><StatusBadge status={s.status} /></td>
                  <td className="py-2 px-3 flex gap-2">
                    <select defaultValue="" disabled={updating === s.id}
                      onChange={e => { if (e.target.value) updateStatus(s.id, e.target.value); }}
                      className="text-xs border border-border rounded px-1 py-1">
                      <option value="" disabled>Update status</option>
                      {["SCHEDULED","IN_PROGRESS","COMPLETED","POSTPONED"].map(st =>
                        <option key={st} value={st}>{st}</option>)}
                    </select>
                    <button onClick={() => cancel(s.id)} className="text-xs text-red-500 hover:underline">Cancel</button>
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

function NewBookingTab() {
  const [form, setForm] = useState({ patient_uid: "", procedure_name: "", surgeon_uid: "", theatre_number: "", scheduled_at: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const submit = async () => {
    if (!form.patient_uid || !form.procedure_name || !form.surgeon_uid) {
      alert("Patient UID, procedure name, and surgeon UID are required"); return;
    }
    setSaving(true); setSuccess(false);
    try {
      await postJSON("/api/v1/theatre/schedule", form);
      setSuccess(true);
      setForm({ patient_uid: "", procedure_name: "", surgeon_uid: "", theatre_number: "", scheduled_at: "", notes: "" });
    } catch (e) { alert(e instanceof Error ? e.message : "Failed to create booking"); }
    finally { setSaving(false); }
  };

  return (
    <div className="max-w-md space-y-3">
      <h2 className="text-lg font-semibold">New Theatre Booking</h2>
      {success && <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">Booking created.</div>}
      {[
        { key: "patient_uid", label: "Patient UID *" },
        { key: "procedure_name", label: "Procedure name *" },
        { key: "surgeon_uid", label: "Surgeon UID *" },
        { key: "theatre_number", label: "Theatre number (optional)" },
      ].map(({ key, label }) => (
        <input key={key} placeholder={label} value={(form as Record<string, string>)[key]}
          onChange={e => setForm({ ...form, [key]: e.target.value })}
          className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
      ))}
      <input type="datetime-local" value={form.scheduled_at} onChange={e => setForm({ ...form, scheduled_at: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm" />
      <textarea rows={2} placeholder="Notes (optional)" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none" />
      <button onClick={submit} disabled={saving}
        className="w-full py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50">
        {saving ? "Creating..." : "Create Booking"}</button>
    </div>
  );
}

function AvailabilityTab() {
  const [availability, setAvailability] = useState<TheatreAvailability[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetchAdminAPI<{ data: TheatreAvailability[] }>("/theatre/availability");
      const data = (r as Record<string, unknown>).data ?? r;
      setAvailability(Array.isArray(data) ? data : []);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load availability"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Theatre Availability</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">↻ Refresh</button>
      </div>
      {loading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">{error}</div>}
      {!loading && availability.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">No availability data</div>
      )}
      {availability.length > 0 && availability.map(a => (
        <div key={a.theatre_number} className="border border-border rounded-lg p-4">
          <h3 className="font-semibold mb-2">Theatre {a.theatre_number} — {a.date}</h3>
          <div className="flex flex-wrap gap-2">
            {a.slots.map(slot => (
              <span key={slot} className="px-2 py-1 bg-green-50 text-green-700 rounded text-xs">{slot}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TheatreContent() {
  const [tab, setTab] = useState<"today" | "new" | "availability">("today");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Operating Theatre</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[{ key: "today" as const, label: "🏥 Today" }, { key: "new" as const, label: "+ New Booking" }, { key: "availability" as const, label: "📅 Availability" }].map(({ key, label }) => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === key ? "bg-white text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {label}</button>
        ))}
      </div>
      {tab === "today" && <TodayTab />}
      {tab === "new" && <NewBookingTab />}
      {tab === "availability" && <AvailabilityTab />}
    </div>
  );
}

export default function TheatrePage() {
  return <Suspense fallback={<div className="p-6">Loading theatre...</div>}><TheatreContent /></Suspense>;
}
