// src/app/(with-auth)/dashboard/blood-bank/page.tsx
"use client";

import { useState, Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ClipboardList,
  Droplets,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Users,
} from "lucide-react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";

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
  requested_at?: string;
  created_at?: string;
};

type InventoryItem = {
  blood_group: string;
  component?: string;
  units_available?: number;
  requested_units?: number;
  cross_matched_units?: number;
  issued_units?: number;
  transfused_units?: number;
  total_requests?: number;
  last_updated?: string;
};

type Donor = {
  id: number;
  donor_uid: string;
  full_name: string;
  phone?: string | null;
  gender?: string | null;
  date_of_birth?: string | null;
  blood_group?: string | null;
  status: string;
  eligibility_status: string;
  registered_at: string;
  last_screened_at?: string | null;
  last_donated_at?: string | null;
  active_deferrals?: number;
};

type Deferral = {
  id: number;
  donor_id: number;
  reason_code: string;
  reason_text: string;
  deferred_until?: string | null;
  permanent: boolean;
  status: string;
  source: string;
  created_at: string;
  full_name: string;
  phone?: string | null;
  blood_group?: string | null;
};

const STATUS_COLORS: Record<string, string> = {
  PENDING: "bg-yellow-100 text-yellow-800",
  REQUESTED: "bg-yellow-100 text-yellow-800",
  CROSS_MATCHED: "bg-blue-100 text-blue-800",
  ISSUED: "bg-orange-100 text-orange-800",
  TRANSFUSED: "bg-green-100 text-green-800",
  CANCELLED: "bg-gray-100 text-gray-600",
  ACTIVE: "bg-green-100 text-green-800",
  REGISTERED: "bg-slate-100 text-slate-700",
  DEFERRED_TEMPORARY: "bg-amber-100 text-amber-800",
  DEFERRED_PERMANENT: "bg-red-100 text-red-800",
  ELIGIBLE: "bg-green-100 text-green-800",
  REACTIVATED: "bg-blue-100 text-blue-800",
  COLLECTED: "bg-purple-100 text-purple-800",
  NOT_SCREENED: "bg-slate-100 text-slate-700",
};

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const BLOOD_BANK_CHANNEL = "staff:blood-bank";

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
  if (!d) return "-";
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

function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
      title="Refresh"
      aria-label="Refresh"
    >
      <RefreshCw className="h-4 w-4" />
      Refresh
    </button>
  );
}

function InventoryTab() {
  const {
    data: inventory = [],
    isLoading: loading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["blood-bank", "inventory"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ data: InventoryItem[] }>(
        "/blood-bank/inventory",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as InventoryItem[]) : [];
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Blood Inventory</h2>
        <RefreshButton onClick={() => refetch()} />
      </div>
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error instanceof Error ? error.message : "Failed to load inventory"}
        </div>
      )}
      {!loading && inventory.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No inventory data
        </div>
      )}
      {inventory.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {inventory.map((item) => {
            const available = item.units_available ?? 0;
            const total = item.total_requests ?? available;
            return (
              <div
                key={`${item.blood_group}-${item.component ?? "all"}`}
                className={`border rounded-lg p-4 ${available < 3 ? "border-red-300 bg-red-50" : "border-border bg-card"}`}
              >
                <p className="text-sm text-muted-foreground">{item.component ?? "All components"}</p>
                <p className="text-2xl font-bold text-foreground">{item.blood_group}</p>
                <p className={`text-3xl font-bold mt-1 ${available < 3 ? "text-red-600" : "text-green-600"}`}>
                  {available}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {total} tracked request{total === 1 ? "" : "s"}
                </p>
                {item.last_updated && (
                  <p className="text-xs text-muted-foreground">{fmtDate(item.last_updated)}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PendingRequestsTab() {
  const qc = useQueryClient();
  const {
    data: requests = [],
    isLoading: loading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["blood-bank", "pending"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ data: BloodRequest[] }>(
        "/blood-bank/pending",
      );
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as BloodRequest[]) : [];
    },
  });

  const action = useMutation({
    mutationFn: ({ id, endpoint }: { id: number; endpoint: string }) =>
      putJSON(`/api/v1/blood-bank/${id}/${endpoint}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blood-bank"] }),
    onError: (e) => alert(e instanceof Error ? e.message : "Action failed"),
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Pending Requests</h2>
        <RefreshButton onClick={() => refetch()} />
      </div>
      {loading && (
        <div className="text-center py-8 text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error instanceof Error ? error.message : "Failed to load requests"}
        </div>
      )}
      {!loading && requests.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">
          No pending requests
        </div>
      )}
      {requests.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">ID</th>
                <th className="py-2 px-3">Blood Group</th>
                <th className="py-2 px-3">Units</th>
                <th className="py-2 px-3">Status</th>
                <th className="py-2 px-3">Requested</th>
                <th className="py-2 px-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3 font-mono text-xs">{r.id}</td>
                  <td className="py-2 px-3 font-bold text-red-700">{r.blood_group}</td>
                  <td className="py-2 px-3">{r.units}</td>
                  <td className="py-2 px-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="py-2 px-3">{fmtDate(r.requested_at ?? r.created_at)}</td>
                  <td className="py-2 px-3 flex gap-1 flex-wrap">
                    {!r.cross_match_done && (
                      <button
                        onClick={() => action.mutate({ id: r.id, endpoint: "cross-match" })}
                        disabled={action.isPending && action.variables?.id === r.id}
                        className="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded hover:bg-blue-100 disabled:opacity-50"
                      >
                        Cross-match
                      </button>
                    )}
                    {r.cross_match_done && r.status !== "ISSUED" && r.status !== "TRANSFUSED" && (
                      <button
                        onClick={() => action.mutate({ id: r.id, endpoint: "issue" })}
                        disabled={action.isPending && action.variables?.id === r.id}
                        className="text-xs bg-orange-50 text-orange-700 px-2 py-1 rounded hover:bg-orange-100 disabled:opacity-50"
                      >
                        Issue
                      </button>
                    )}
                    {r.status === "ISSUED" && (
                      <button
                        onClick={() => action.mutate({ id: r.id, endpoint: "transfused" })}
                        disabled={action.isPending && action.variables?.id === r.id}
                        className="text-xs bg-green-50 text-green-700 px-2 py-1 rounded hover:bg-green-100 disabled:opacity-50"
                      >
                        Transfused
                      </button>
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
  const qc = useQueryClient();
  const [form, setForm] = useState({
    patient_uid: "",
    blood_group: "O+",
    component: "prbc",
    units: 1,
    clinical_indication: "",
  });
  const [created, setCreated] = useState(false);

  const create = useMutation({
    mutationFn: () => postJSON("/api/v1/blood-bank/request", form),
    onSuccess: () => {
      setCreated(true);
      setForm({ patient_uid: "", blood_group: "O+", component: "prbc", units: 1, clinical_indication: "" });
      qc.invalidateQueries({ queryKey: ["blood-bank"] });
    },
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to create request"),
  });

  const submit = () => {
    if (!form.patient_uid || !form.clinical_indication) {
      alert("Patient UID and indication are required");
      return;
    }
    setCreated(false);
    create.mutate();
  };

  return (
    <div className="max-w-lg space-y-3">
      <h2 className="text-lg font-semibold">New Blood Request</h2>
      {created && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-700 text-sm">
          Request created.
        </div>
      )}
      <input
        placeholder="Patient UID"
        value={form.patient_uid}
        onChange={(e) => setForm({ ...form, patient_uid: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select
          value={form.blood_group}
          onChange={(e) => setForm({ ...form, blood_group: e.target.value })}
          className="border border-border rounded-lg px-3 py-2 text-sm"
        >
          {BLOOD_GROUPS.map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <select
          value={form.component}
          onChange={(e) => setForm({ ...form, component: e.target.value })}
          className="border border-border rounded-lg px-3 py-2 text-sm"
        >
          <option value="prbc">PRBC</option>
          <option value="whole_blood">Whole blood</option>
          <option value="ffp">FFP</option>
          <option value="platelets">Platelets</option>
          <option value="cryoprecipitate">Cryoprecipitate</option>
        </select>
        <input
          type="number"
          min={1}
          value={form.units}
          onChange={(e) => setForm({ ...form, units: parseInt(e.target.value) || 1 })}
          className="border border-border rounded-lg px-3 py-2 text-sm"
        />
      </div>
      <textarea
        rows={2}
        placeholder="Clinical indication"
        value={form.clinical_indication}
        onChange={(e) => setForm({ ...form, clinical_indication: e.target.value })}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
      />
      <button
        onClick={submit}
        disabled={create.isPending}
        className="inline-flex items-center justify-center gap-2 w-full py-2 bg-primary text-white rounded-lg text-sm font-medium disabled:opacity-50"
      >
        <Plus className="h-4 w-4" />
        {create.isPending ? "Creating..." : "Create Request"}
      </button>
    </div>
  );
}

function DonorRegistryTab() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [form, setForm] = useState({
    full_name: "",
    phone: "",
    gender: "",
    date_of_birth: "",
    blood_group: "O+",
    address: "",
    duplicate_override_reason: "",
  });
  const {
    data: donors = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["blood-bank", "donors", q],
    queryFn: async () => {
      const suffix = q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "";
      const r = await fetchAdminAPI<{ data: Donor[] }>(`/blood-bank/donors${suffix}`);
      const data = (r as Record<string, unknown>).data ?? r;
      return Array.isArray(data) ? (data as Donor[]) : [];
    },
  });

  const create = useMutation({
    mutationFn: () => postJSON("/api/v1/blood-bank/donors", form),
    onSuccess: () => {
      setForm({
        full_name: "",
        phone: "",
        gender: "",
        date_of_birth: "",
        blood_group: "O+",
        address: "",
        duplicate_override_reason: "",
      });
      qc.invalidateQueries({ queryKey: ["blood-bank"] });
    },
    onError: (e) => alert(e instanceof Error ? e.message : "Donor registration failed"),
  });

  return (
    <div className="space-y-5">
      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <div className="border border-border rounded-lg p-4 space-y-3 bg-card">
          <h2 className="text-lg font-semibold">Register Donor</h2>
          <input
            placeholder="Full name"
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm"
          />
          <input
            placeholder="Phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
              className="border border-border rounded-lg px-3 py-2 text-sm"
            />
            <select
              value={form.blood_group}
              onChange={(e) => setForm({ ...form, blood_group: e.target.value })}
              className="border border-border rounded-lg px-3 py-2 text-sm"
            >
              {BLOOD_GROUPS.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>
          <input
            placeholder="Gender"
            value={form.gender}
            onChange={(e) => setForm({ ...form, gender: e.target.value })}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm"
          />
          <textarea
            rows={2}
            placeholder="Address"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
          />
          <textarea
            rows={2}
            placeholder="Duplicate override reason"
            value={form.duplicate_override_reason}
            onChange={(e) => setForm({ ...form, duplicate_override_reason: e.target.value })}
            className="w-full border border-border rounded-lg px-3 py-2 text-sm resize-none"
          />
          <button
            onClick={() => create.mutate()}
            disabled={create.isPending || !form.full_name}
            className="inline-flex items-center justify-center gap-2 w-full bg-primary text-white rounded-lg py-2 text-sm font-medium disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            {create.isPending ? "Registering..." : "Register Donor"}
          </button>
        </div>

        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold">Donor Registry</h2>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="h-4 w-4 absolute left-3 top-2.5 text-muted-foreground" />
                <input
                  placeholder="Search donors"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  className="border border-border rounded-lg pl-9 pr-3 py-2 text-sm"
                />
              </div>
              <RefreshButton onClick={() => refetch()} />
            </div>
          </div>
          {isLoading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
              {error instanceof Error ? error.message : "Failed to load donors"}
            </div>
          )}
          {!isLoading && donors.length === 0 && !error && (
            <div className="text-center py-12 text-muted-foreground">No donors found</div>
          )}
          {donors.length > 0 && (
            <div className="overflow-x-auto border border-border rounded-lg">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left bg-muted/50">
                    <th className="py-2 px-3">Donor</th>
                    <th className="py-2 px-3">Group</th>
                    <th className="py-2 px-3">Status</th>
                    <th className="py-2 px-3">Eligibility</th>
                    <th className="py-2 px-3">Registered</th>
                  </tr>
                </thead>
                <tbody>
                  {donors.map((donor) => (
                    <tr key={donor.id} className="border-b border-border hover:bg-muted/40">
                      <td className="py-2 px-3">
                        <div className="font-medium">{donor.full_name}</div>
                        <div className="text-xs text-muted-foreground">#{donor.id} {donor.phone ?? ""}</div>
                      </td>
                      <td className="py-2 px-3 font-semibold text-red-700">{donor.blood_group ?? "-"}</td>
                      <td className="py-2 px-3"><StatusBadge status={donor.status} /></td>
                      <td className="py-2 px-3"><StatusBadge status={donor.eligibility_status} /></td>
                      <td className="py-2 px-3">{fmtDate(donor.registered_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScreeningTab() {
  const qc = useQueryClient();
  const [donorId, setDonorId] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [form, setForm] = useState({
    weight_kg: "62",
    hemoglobin_g_dl: "13.2",
    systolic_bp: "116",
    diastolic_bp: "72",
    temperature_c: "36.7",
    recent_fever: false,
    tattoo_recent: false,
    pregnant: false,
    previous_positive_tti: false,
  });

  const screen = useMutation({
    mutationFn: () =>
      postJSON(`/api/v1/blood-bank/donors/${donorId}/screenings`, {
        questionnaire: {
          recent_fever: form.recent_fever,
          tattoo_recent: form.tattoo_recent,
          pregnant: form.pregnant,
          previous_positive_tti: form.previous_positive_tti,
        },
        vitals: {
          weight_kg: Number(form.weight_kg),
          hemoglobin_g_dl: Number(form.hemoglobin_g_dl),
          systolic_bp: Number(form.systolic_bp),
          diastolic_bp: Number(form.diastolic_bp),
          temperature_c: Number(form.temperature_c),
        },
      }),
    onSuccess: (data) => {
      const payload = data as { screening?: { verdict?: string }; data?: { screening?: { verdict?: string } } };
      setResult(payload.screening?.verdict ?? payload.data?.screening?.verdict ?? "recorded");
      qc.invalidateQueries({ queryKey: ["blood-bank"] });
    },
    onError: (e) => alert(e instanceof Error ? e.message : "Screening failed"),
  });

  return (
    <div className="max-w-2xl space-y-4">
      <h2 className="text-lg font-semibold">Donor Screening</h2>
      {result && (
        <div className="border border-border rounded-lg p-3 text-sm">
          Verdict: <StatusBadge status={result} />
        </div>
      )}
      <input
        placeholder="Donor ID"
        value={donorId}
        onChange={(e) => setDonorId(e.target.value)}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {[
          ["weight_kg", "Weight kg"],
          ["hemoglobin_g_dl", "Hb g/dL"],
          ["systolic_bp", "SBP"],
          ["diastolic_bp", "DBP"],
          ["temperature_c", "Temp C"],
        ].map(([key, label]) => (
          <input
            key={key}
            type="number"
            step="0.1"
            placeholder={label}
            value={form[key as keyof typeof form] as string}
            onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        ))}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {[
          ["recent_fever", "Recent fever"],
          ["tattoo_recent", "Recent tattoo"],
          ["pregnant", "Pregnant or recent delivery"],
          ["previous_positive_tti", "Prior positive TTI"],
        ].map(([key, label]) => (
          <label key={key} className="flex items-center gap-2 border border-border rounded-lg px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={form[key as keyof typeof form] as boolean}
              onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
      </div>
      <button
        onClick={() => screen.mutate()}
        disabled={screen.isPending || !donorId}
        className="inline-flex items-center justify-center gap-2 bg-primary text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        <ShieldCheck className="h-4 w-4" />
        {screen.isPending ? "Recording..." : "Record Screening"}
      </button>
    </div>
  );
}

function DeferralBoardTab() {
  const qc = useQueryClient();
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const {
    data,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["blood-bank", "deferrals"],
    queryFn: async () => {
      const r = await fetchAdminAPI<{ deferrals: Deferral[] }>("/blood-bank/deferrals");
      const payload = r as { deferrals?: Deferral[]; data?: { deferrals?: Deferral[] } };
      return payload.deferrals ?? payload.data?.deferrals ?? [];
    },
  });

  const reactivate = useMutation({
    mutationFn: ({ donorId, deferralId, reason }: { donorId: number; deferralId: number; reason: string }) =>
      postJSON(`/api/v1/blood-bank/donors/${donorId}/deferrals/${deferralId}/reactivate`, {
        reactivation_reason: reason,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blood-bank"] }),
    onError: (e) => alert(e instanceof Error ? e.message : "Reactivation failed"),
  });

  const deferrals = data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Deferral Board</h2>
        <RefreshButton onClick={() => refetch()} />
      </div>
      {isLoading && <div className="text-center py-8 text-muted-foreground">Loading...</div>}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-red-700 text-sm">
          {error instanceof Error ? error.message : "Failed to load deferrals"}
        </div>
      )}
      {!isLoading && deferrals.length === 0 && !error && (
        <div className="text-center py-12 text-muted-foreground">No active deferrals</div>
      )}
      {deferrals.length > 0 && (
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left bg-muted/50">
                <th className="py-2 px-3">Donor</th>
                <th className="py-2 px-3">Reason</th>
                <th className="py-2 px-3">Until</th>
                <th className="py-2 px-3">Reactivation</th>
              </tr>
            </thead>
            <tbody>
              {deferrals.map((row) => (
                <tr key={row.id} className="border-b border-border hover:bg-muted/40">
                  <td className="py-2 px-3">
                    <div className="font-medium">{row.full_name}</div>
                    <div className="text-xs text-muted-foreground">#{row.donor_id} {row.blood_group ?? ""}</div>
                  </td>
                  <td className="py-2 px-3">
                    <div className="font-medium">{row.reason_code}</div>
                    <div className="text-xs text-muted-foreground max-w-md">{row.reason_text}</div>
                  </td>
                  <td className="py-2 px-3">
                    {row.permanent ? (
                      <span className="inline-flex items-center gap-1 text-red-700">
                        <AlertTriangle className="h-4 w-4" />
                        Permanent
                      </span>
                    ) : fmtDate(row.deferred_until)}
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex gap-2 min-w-[300px]">
                      <input
                        placeholder="Reactivation reason"
                        value={reasons[row.id] ?? ""}
                        onChange={(e) => setReasons({ ...reasons, [row.id]: e.target.value })}
                        className="flex-1 border border-border rounded-lg px-3 py-2 text-xs"
                      />
                      <button
                        title="Reactivate"
                        aria-label="Reactivate"
                        onClick={() => reactivate.mutate({
                          donorId: row.donor_id,
                          deferralId: row.id,
                          reason: reasons[row.id] ?? "",
                        })}
                        disabled={reactivate.isPending || !(reasons[row.id] ?? "").trim()}
                        className="inline-flex items-center justify-center bg-blue-50 text-blue-700 rounded-lg px-3 py-2 text-xs font-medium hover:bg-blue-100 disabled:opacity-50"
                      >
                        <RotateCcw className="h-4 w-4" />
                      </button>
                    </div>
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

function BloodBankContent() {
  const [tab, setTab] = useState<"inventory" | "pending" | "new" | "donors" | "screening" | "deferrals">("inventory");

  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(BLOOD_BANK_CHANNEL, [
    ["blood-bank"],
  ]);

  const liveLabel = subscribed ? "Live" : connected ? "Connecting" : "Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:blood-bank - last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:blood-bank"
    : connected
      ? "Connecting..."
      : "Offline - refresh manually (real-time unavailable)";

  const tabs = [
    { key: "inventory" as const, label: "Inventory", icon: Droplets },
    { key: "pending" as const, label: "Requests", icon: ClipboardList },
    { key: "new" as const, label: "New Request", icon: Plus },
    { key: "donors" as const, label: "Donors", icon: Users },
    { key: "screening" as const, label: "Screening", icon: ShieldCheck },
    { key: "deferrals" as const, label: "Deferrals", icon: Activity },
  ];

  return (
    <div className="p-6">
      <div className="flex items-center gap-2 mb-6">
        <h1 className="text-3xl font-bold">Blood Bank</h1>
        <span
          data-testid="blood-bank-realtime-indicator"
          role="status"
          aria-label={subscribed ? "Live - real-time blood-bank updates active" : "Offline - real-time updates unavailable"}
          title={liveTitle}
          className={subscribed ? "text-xs font-medium text-green-600" : "text-xs font-medium text-gray-400"}
        >
          {liveLabel}
        </span>
      </div>
      <div className="flex flex-wrap gap-1 bg-muted rounded-lg p-1 mb-6">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>
      {tab === "inventory" && <InventoryTab />}
      {tab === "pending" && <PendingRequestsTab />}
      {tab === "new" && <NewRequestTab />}
      {tab === "donors" && <DonorRegistryTab />}
      {tab === "screening" && <ScreeningTab />}
      {tab === "deferrals" && <DeferralBoardTab />}
    </div>
  );
}

export default function BloodBankPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading blood bank...</div>}>
      <BloodBankContent />
    </Suspense>
  );
}
