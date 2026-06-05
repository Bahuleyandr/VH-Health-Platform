// src/app/(with-auth)/dashboard/referral/page.tsx
"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";

type Referral = {
  id: number;
  patient_uid: string;
  from_department?: string;
  to_department: string;
  reason: string;
  status: string;
  priority?: string;
  doctor_notes?: string;
  decline_reason?: string;
  referred_at: string;
  updated_at?: string;
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  ACCEPTED: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-green-100 text-green-800",
  DECLINED: "bg-red-100 text-red-800",
  CANCELLED: "bg-gray-100 text-gray-600",
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

type ReferralTableProps = {
  referrals: Referral[];
  onAccept?: (id: number) => void;
  onComplete?: (id: number) => void;
  onDecline?: (id: number) => void;
  acting: number | null;
};

function ReferralTable({
  referrals,
  onAccept,
  onComplete,
  onDecline,
  acting,
}: ReferralTableProps) {
  if (referrals.length === 0)
    return (
      <div className="text-center py-12 text-muted-foreground">
        No referrals
      </div>
    );
  return (
    <div className="overflow-x-auto border border-border rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left bg-muted/50">
            <th className="py-2 px-3">ID</th>
            <th className="py-2 px-3">To Dept</th>
            <th className="py-2 px-3">Reason</th>
            <th className="py-2 px-3">Status</th>
            <th className="py-2 px-3">Date</th>
            <th className="py-2 px-3">Actions</th>
          </tr>
        </thead>
        <tbody>
          {referrals.map((r) => (
            <tr key={r.id} className="border-b border-border hover:bg-muted/40">
              <td className="py-2 px-3 font-mono text-xs">{r.id}</td>
              <td className="py-2 px-3 font-medium">{r.to_department}</td>
              <td className="py-2 px-3 max-w-xs truncate text-xs text-muted-foreground">
                {r.reason}
              </td>
              <td className="py-2 px-3">
                <StatusBadge status={r.status} />
              </td>
              <td className="py-2 px-3">{fmtDate(r.referred_at)}</td>
              <td className="py-2 px-3 flex gap-1">
                {onAccept && r.status === "PENDING" && (
                  <button
                    onClick={() => onAccept(r.id)}
                    disabled={acting === r.id}
                    className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100 disabled:opacity-50"
                  >
                    Accept
                  </button>
                )}
                {onComplete && r.status === "ACCEPTED" && (
                  <button
                    onClick={() => onComplete(r.id)}
                    disabled={acting === r.id}
                    className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded hover:bg-green-100 disabled:opacity-50"
                  >
                    Complete
                  </button>
                )}
                {onDecline && r.status === "PENDING" && (
                  <button
                    onClick={() => onDecline(r.id)}
                    disabled={acting === r.id}
                    className="text-xs bg-red-50 text-red-700 px-2 py-1 rounded hover:bg-red-100 disabled:opacity-50"
                  >
                    Decline
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IncomingTab() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<number | null>(null);
  const [declining, setDeclining] = useState<{
    id: number;
    reason: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: Referral[] }>(
        "/referrals/incoming",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setReferrals(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load incoming referrals",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const accept = async (id: number) => {
    setActing(id);
    try {
      await putJSON(`/api/v1/referrals/${id}/accept`, {});
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setActing(null);
    }
  };

  const complete = async (id: number) => {
    setActing(id);
    try {
      await putJSON(`/api/v1/referrals/${id}/complete`, {});
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setActing(null);
    }
  };

  const decline = async () => {
    if (!declining) return;
    setActing(declining.id);
    try {
      await putJSON(`/api/v1/referrals/${declining.id}/decline`, {
        reason: declining.reason,
      });
      setDeclining(null);
      load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed");
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Incoming Referrals</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">
          ↻ Refresh
        </button>
      </div>
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}
      {!loading && (
        <ReferralTable
          referrals={referrals}
          onAccept={accept}
          onComplete={complete}
          onDecline={(id) => setDeclining({ id, reason: "" })}
          acting={acting}
        />
      )}
      {declining && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-card rounded-xl max-w-md w-full p-6 space-y-3">
            <div className="flex justify-between">
              <h3 className="font-bold">Decline Referral #{declining.id}</h3>
              <button
                onClick={() => setDeclining(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <textarea
              rows={3}
              placeholder="Reason for declining *"
              value={declining.reason}
              onChange={(e) =>
                setDeclining({ ...declining, reason: e.target.value })
              }
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm resize-none"
            />
            <div className="flex gap-2">
              <button
                onClick={() => setDeclining(null)}
                className="flex-1 py-2 border rounded-lg text-sm"
              >
                Cancel
              </button>
              <button
                onClick={decline}
                className="flex-1 py-2 bg-red-600 text-white rounded-lg text-sm"
              >
                Decline
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OutgoingTab() {
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchAdminAPI<{ data: Referral[] }>(
        "/referrals/outgoing",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      setReferrals(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load outgoing referrals",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Outgoing Referrals</h2>
        <button onClick={load} className="text-sm text-primary hover:underline">
          ↻ Refresh
        </button>
      </div>
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error}
        </div>
      )}
      {!loading && <ReferralTable referrals={referrals} acting={null} />}
    </div>
  );
}

function NewReferralTab() {
  const [form, setForm] = useState({
    patient_uid: "",
    to_department: "",
    reason: "",
    priority: "NORMAL",
    doctor_notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const submit = async () => {
    if (!form.patient_uid || !form.to_department || !form.reason) {
      alert("Patient UID, department, and reason are required");
      return;
    }
    setSaving(true);
    setSuccess(false);
    try {
      await postJSON("/api/v1/referrals", form);
      setSuccess(true);
      setForm({
        patient_uid: "",
        to_department: "",
        reason: "",
        priority: "NORMAL",
        doctor_notes: "",
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to create referral");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-md space-y-3">
      <h2 className="text-lg font-semibold">New Referral</h2>
      {success && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">
          Referral created.
        </div>
      )}
      <input
        placeholder="Patient UID *"
        value={form.patient_uid}
        onChange={(e) => setForm({ ...form, patient_uid: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <input
        placeholder="To department *"
        value={form.to_department}
        onChange={(e) => setForm({ ...form, to_department: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <textarea
        rows={2}
        placeholder="Reason *"
        value={form.reason}
        onChange={(e) => setForm({ ...form, reason: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
      />
      <select
        value={form.priority}
        onChange={(e) => setForm({ ...form, priority: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      >
        {["NORMAL", "HIGH", "URGENT"].map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <textarea
        rows={2}
        placeholder="Doctor notes (optional)"
        value={form.doctor_notes}
        onChange={(e) => setForm({ ...form, doctor_notes: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
      />
      <button
        onClick={submit}
        disabled={saving}
        className="w-full py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50"
      >
        {saving ? "Creating..." : "Create Referral"}
      </button>
    </div>
  );
}

function ReferralContent() {
  const [tab, setTab] = useState<"incoming" | "outgoing" | "new">("incoming");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold mb-6">Referrals</h1>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6">
        {[
          { key: "incoming" as const, label: "📥 Incoming" },
          { key: "outgoing" as const, label: "📤 Outgoing" },
          { key: "new" as const, label: "+ New Referral" },
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
      {tab === "incoming" && <IncomingTab />}
      {tab === "outgoing" && <OutgoingTab />}
      {tab === "new" && <NewReferralTab />}
    </div>
  );
}

export default function ReferralPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading referrals...</div>}>
      <ReferralContent />
    </Suspense>
  );
}
