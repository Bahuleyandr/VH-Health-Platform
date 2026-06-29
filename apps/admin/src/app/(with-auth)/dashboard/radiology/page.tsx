// src/app/(with-auth)/dashboard/radiology/page.tsx
"use client";

import { useState, Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";

const RADIOLOGY_CHANNEL = "staff:radiology";

type RadiologyOrder = {
  id: number;
  patient_uid: string;
  modality: string;
  body_part?: string;
  clinical_indication?: string;
  status: string;
  priority?: string;
  notes?: string;
  created_at: string;
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
    <span
      className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[status?.toUpperCase()] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

function fmtDate(d?: string | null) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return d;
  }
}

function WorklistTab() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<RadiologyOrder | null>(null);
  const [report, setReport] = useState("");

  const { data: orders = [], isLoading: loading, error, refetch } = useQuery({
    queryKey: ["radiology", "worklist"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ data: RadiologyOrder[] }>("/radiology/worklist");
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as RadiologyOrder[]) : [];
    },
  });

  const reportMut = useMutation({
    mutationFn: (orderId: number) => putJSON(`/api/v1/radiology/${orderId}/report`, { report }),
    onSuccess: () => { setSelected(null); setReport(""); qc.invalidateQueries({ queryKey: ["radiology"] }); },
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to submit report"),
  });

  const cancelMut = useMutation({
    mutationFn: (orderId: number) => putJSON(`/api/v1/radiology/${orderId}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["radiology"] }),
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to cancel"),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Radiology Worklist</h2>
        <button
          onClick={() => refetch()}
          className="text-sm text-primary hover:underline"
        >
          ↻ Refresh
        </button>
      </div>
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error instanceof Error ? error.message : "Failed to load worklist"}
        </div>
      )}
      {!loading && orders.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No pending orders
        </div>
      )}
      {orders.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">ID</th>
                <th className="py-2 px-3">Modality</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Ordered</th>
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="py-2 px-3 font-mono text-xs">{o.id}</td>
                  <td className="py-2 px-3 font-medium">{o.modality}</td>
                  <td className="py-2 px-3">
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="py-2 px-3">{fmtDate(o.created_at)}</td>
                  <td className="py-2 px-3 flex gap-2">
                    <button
                      onClick={() => { setSelected(o); setReport(""); }}
                      className="text-xs text-primary hover:underline"
                    >
                      Report
                    </button>
                    <button
                      onClick={() => { if (confirm("Cancel this order?")) cancelMut.mutate(o.id); }}
                      className="text-xs text-red-500 hover:underline"
                    >
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between">
              <h3 className="font-bold">Add Report — #{selected.id}</h3>
              <button
                onClick={() => setSelected(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={4}
              placeholder="Report findings / impression"
              value={report}
              onChange={(e) => setReport(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setSelected(null)}
                className="flex-1 py-2 border rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => selected && reportMut.mutate(selected.id)}
                disabled={reportMut.isPending || !report.trim()}
                className="flex-1 py-2 bg-primary text-white rounded-lg text-sm disabled:opacity-50"
              >
                {reportMut.isPending ? "Saving..." : "Submit Report"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewOrderTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    patient_uid: "",
    modality: "",
    body_part: "",
    clinical_indication: "",
    priority: "NORMAL",
    notes: "",
  });
  const [success, setSuccess] = useState(false);

  const create = useMutation({
    mutationFn: () => postJSON("/api/v1/radiology/orders", form),
    onSuccess: () => {
      setSuccess(true);
      setForm({ patient_uid: "", modality: "", body_part: "", clinical_indication: "", priority: "NORMAL", notes: "" });
      qc.invalidateQueries({ queryKey: ["radiology"] });
    },
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to create order"),
  });

  const submit = () => {
    if (!form.patient_uid || !form.modality || !form.body_part || !form.clinical_indication) {
      alert("Patient UID, modality, body part, and clinical indication are required");
      return;
    }
    setSuccess(false);
    create.mutate();
  };

  return (
    <div className="max-w-md space-y-3">
      <h2 className="text-lg font-semibold">New Radiology Order</h2>
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">
          Order created successfully.
        </div>
      )}
      <input
        placeholder="Patient UID *"
        value={form.patient_uid}
        onChange={(e) => setForm({ ...form, patient_uid: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <input
        placeholder="Modality (e.g. X-RAY, CT, MRI) *"
        value={form.modality}
        onChange={(e) => setForm({ ...form, modality: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <input
        placeholder="Body part (e.g. Chest, Abdomen) *"
        value={form.body_part}
        onChange={(e) => setForm({ ...form, body_part: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <input
        placeholder="Clinical indication *"
        value={form.clinical_indication}
        onChange={(e) => setForm({ ...form, clinical_indication: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <select
        value={form.priority}
        onChange={(e) => setForm({ ...form, priority: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      >
        {["NORMAL", "HIGH", "URGENT", "STAT"].map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <textarea
        rows={2}
        placeholder="Notes (optional)"
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
      />
      <button
        onClick={submit}
        disabled={create.isPending}
        className="w-full py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {create.isPending ? "Creating..." : "Create Order"}
      </button>
    </div>
  );
}

function RadiologyContent() {
  const [tab, setTab] = useState<"worklist" | "new">("worklist");
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(RADIOLOGY_CHANNEL, [["radiology"]]);
  const liveLabel = subscribed ? "● Live" : connected ? "○ Connecting" : "○ Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:radiology — last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:radiology"
    : connected ? "Connecting…" : "Offline — refresh manually (real-time unavailable)";
  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-3xl font-bold">Radiology</h1>
        <span data-testid="radiology-realtime-indicator" role="status"
          aria-label={subscribed ? "Live — real-time radiology updates active" : "Offline — real-time updates unavailable"}
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}>
          {liveLabel}
        </span>
      </div>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[
          { key: "worklist" as const, label: "🔬 Worklist" },
          { key: "new" as const, label: "+ New Order" },
        ].map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "worklist" && <WorklistTab />}
      {tab === "new" && <NewOrderTab />}
    </div>
  );
}

export default function RadiologyPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading radiology...</div>}>
      <RadiologyContent />
    </Suspense>
  );
}
