// src/app/(with-auth)/dashboard/radiology/page.tsx
"use client";

import { useState, Suspense } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, RefreshCw, X } from "lucide-react";
import { APIError, fetchAdminAPI, postJSON, putJSON } from "@/lib/api";
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
  report_signed_off_at?: string | null;
};

type PeerReviewRow = {
  id: number;
  patient_uid: string;
  modality: string;
  body_part?: string | null;
  priority?: string | null;
  status: string;
  radiologist?: string | null;
  report_signed_off_by?: string | null;
  report_signed_off_at?: string | null;
  review_count: number;
  latest_reviewed_at?: string | null;
  max_discrepancy_score?: number | null;
};

type TatMetric = {
  radiology_order_id: number;
  patient_uid: string;
  modality: string;
  body_part?: string | null;
  priority: string;
  status: string;
  ordered_at?: string | null;
  acquired_at?: string | null;
  reported_at?: string | null;
  signed_at?: string | null;
  tat_stage: string;
  current_elapsed_minutes?: number | null;
  ordered_to_signed_minutes?: number | null;
  target_minutes?: number | null;
  warning_minutes?: number | null;
  critical_minutes?: number | null;
  threshold_breached: boolean;
  alert_severity?: string | null;
};

type ActiveTab = "worklist" | "new" | "peerReview" | "tat";

const STATUS_COLORS: Record<string, string> = {
  ORDERED: "bg-yellow-100 text-yellow-800",
  ACQUIRED: "bg-blue-100 text-blue-800",
  COMPLETED: "bg-green-100 text-green-800",
  CANCELLED: "bg-gray-100 text-gray-600",
};

const PRIORITY_COLORS: Record<string, string> = {
  STAT: "bg-red-100 text-red-800",
  URGENT: "bg-amber-100 text-amber-800",
  ROUTINE: "bg-slate-100 text-slate-700",
};

function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const obj = value as { data?: unknown; items?: unknown };
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex min-w-20 justify-center rounded-full px-2 py-1 text-xs font-medium ${STATUS_COLORS[status?.toUpperCase()] ?? "bg-gray-100 text-gray-600"}`}
    >
      {status}
    </span>
  );
}

function PriorityBadge({ priority }: { priority?: string | null }) {
  const value = priority || "routine";
  return (
    <span
      className={`inline-flex min-w-16 justify-center rounded-full px-2 py-1 text-xs font-medium ${PRIORITY_COLORS[value.toUpperCase()] ?? "bg-slate-100 text-slate-700"}`}
    >
      {value}
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

function fmtDateTime(d?: string | null) {
  if (!d) return "-";
  try {
    return new Date(d).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return d;
  }
}

function fmtMinutes(value?: number | null) {
  if (value == null || Number.isNaN(Number(value))) return "-";
  const minutes = Math.max(0, Number(value));
  if (minutes >= 1440) {
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    return `${days}d ${hours}h`;
  }
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  }
  return `${minutes}m`;
}

function WorklistTab() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<RadiologyOrder | null>(null);
  const [report, setReport] = useState("");

  const {
    data: orders = [],
    isLoading: loading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["radiology", "worklist"],
    queryFn: async () =>
      unwrapList<RadiologyOrder>(
        await fetchAdminAPI<unknown>("/radiology/worklist"),
      ),
  });

  const reportMut = useMutation({
    mutationFn: (orderId: number) =>
      putJSON(`/api/v1/radiology/${orderId}/report`, { report }),
    onSuccess: () => {
      setSelected(null);
      setReport("");
      qc.invalidateQueries({ queryKey: ["radiology"] });
    },
    onError: (e) =>
      alert(e instanceof Error ? e.message : "Failed to submit report"),
  });

  const cancelMut = useMutation({
    mutationFn: (orderId: number) =>
      putJSON(`/api/v1/radiology/${orderId}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["radiology"] }),
    onError: (e) => alert(e instanceof Error ? e.message : "Failed to cancel"),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Radiology Worklist</h2>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-foreground hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </button>
      </div>
      {loading && (
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error ? error.message : "Failed to load worklist"}
        </div>
      )}
      {!loading && orders.length === 0 && !error && (
        <div className="py-12 text-center text-muted-foreground">
          No pending orders
        </div>
      )}
      {orders.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2">ID</th>
                <th className="px-3 py-2">Modality</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Ordered</th>
                <th className="px-3 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <tr
                  key={o.id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">{o.id}</td>
                  <td className="px-3 py-2 font-medium">{o.modality}</td>
                  <td className="px-3 py-2">
                    <PriorityBadge priority={o.priority} />
                  </td>
                  <td className="px-3 py-2">
                    <StatusBadge status={o.status} />
                  </td>
                  <td className="px-3 py-2">{fmtDate(o.created_at)}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setSelected(o);
                          setReport("");
                        }}
                        className="rounded-md px-2 py-1 text-xs text-primary hover:bg-primary/10"
                      >
                        Report
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (confirm("Cancel this order?"))
                            cancelMut.mutate(o.id);
                        }}
                        className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-lg bg-card p-6 shadow-lg">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="font-bold">Add Report #{selected.id}</h3>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            <textarea
              rows={4}
              placeholder="Report findings / impression"
              value={report}
              onChange={(e) => setReport(e.target.value)}
              className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm"
            />
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex-1 rounded-lg border py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => selected && reportMut.mutate(selected.id)}
                disabled={reportMut.isPending || !report.trim()}
                className="flex-1 rounded-lg bg-primary py-2 text-sm text-white disabled:opacity-50"
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

type ContrastBlocker = {
  type?: string;
  allergy?: string;
  severity?: string;
  agent_class?: string;
  message?: string;
};

const EMPTY_ORDER_FORM = {
  patient_uid: "",
  modality: "",
  body_part: "",
  clinical_indication: "",
  priority: "routine",
  notes: "",
  // "" = derived server-side (CT/MRI/fluoroscopy presumed contrast and
  // screened); "true"/"false" are explicit clinician intent.
  contrast_planned: "",
  contrast_agent: "",
};

function NewOrderTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState(EMPTY_ORDER_FORM);
  const [success, setSuccess] = useState(false);
  const [contrastBlock, setContrastBlock] = useState<ContrastBlocker[] | null>(
    null,
  );
  const [overrideReason, setOverrideReason] = useState("");

  const buildPayload = (withOverride: boolean) => ({
    patient_uid: form.patient_uid,
    modality: form.modality,
    body_part: form.body_part,
    clinical_indication: form.clinical_indication,
    priority: form.priority,
    notes: form.notes,
    ...(form.contrast_planned !== "" && {
      contrast_planned: form.contrast_planned === "true",
    }),
    ...(form.contrast_planned !== "false" &&
      form.contrast_agent.trim() !== "" && {
        contrast_agent: form.contrast_agent.trim(),
      }),
    ...(withOverride && { override: { reason: overrideReason.trim() } }),
  });

  const create = useMutation({
    mutationFn: (withOverride: boolean) =>
      postJSON("/api/v1/radiology/orders", buildPayload(withOverride)),
    onSuccess: () => {
      setSuccess(true);
      setForm(EMPTY_ORDER_FORM);
      setContrastBlock(null);
      setOverrideReason("");
      qc.invalidateQueries({ queryKey: ["radiology"] });
    },
    onError: (e) => {
      const body =
        e instanceof APIError
          ? (e.data as
              | { code?: string; details?: { blockers?: ContrastBlocker[] } }
              | undefined)
          : undefined;
      if (body?.code === "RADIOLOGY_CONTRAST_ALLERGY_BLOCKED") {
        setContrastBlock(body.details?.blockers ?? []);
        return;
      }
      alert(e instanceof Error ? e.message : "Failed to create order");
    },
  });

  const submit = () => {
    if (
      !form.patient_uid ||
      !form.modality ||
      !form.body_part ||
      !form.clinical_indication
    ) {
      alert(
        "Patient UID, modality, body part, and clinical indication are required",
      );
      return;
    }
    setSuccess(false);
    setContrastBlock(null);
    create.mutate(false);
  };

  return (
    <div className="max-w-lg space-y-3">
      <h2 className="text-lg font-semibold">New Radiology Order</h2>
      {success && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          Order created successfully.
        </div>
      )}
      <input
        placeholder="Patient UID *"
        value={form.patient_uid}
        onChange={(e) => setForm({ ...form, patient_uid: e.target.value })}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      />
      <input
        placeholder="Modality (xray, CT, MRI, ultrasound) *"
        value={form.modality}
        onChange={(e) => setForm({ ...form, modality: e.target.value })}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      />
      <input
        placeholder="Body part (Chest, Abdomen) *"
        value={form.body_part}
        onChange={(e) => setForm({ ...form, body_part: e.target.value })}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      />
      <input
        placeholder="Clinical indication *"
        value={form.clinical_indication}
        onChange={(e) =>
          setForm({ ...form, clinical_indication: e.target.value })
        }
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      />
      <select
        value={form.priority}
        onChange={(e) => setForm({ ...form, priority: e.target.value })}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      >
        {["routine", "urgent", "stat"].map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <select
        aria-label="Contrast plan"
        value={form.contrast_planned}
        onChange={(e) => setForm({ ...form, contrast_planned: e.target.value })}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      >
        <option value="">
          Contrast: decide by modality (CT/MRI/fluoro presumed + screened)
        </option>
        <option value="true">With contrast</option>
        <option value="false">Without contrast (skips allergy screen)</option>
      </select>
      {form.contrast_planned !== "false" && (
        <input
          aria-label="Contrast agent"
          placeholder="Contrast agent (optional, e.g. iohexol, gadobutrol)"
          value={form.contrast_agent}
          onChange={(e) => setForm({ ...form, contrast_agent: e.target.value })}
          className="w-full rounded-lg border border-border px-3 py-2 text-sm"
        />
      )}
      <textarea
        rows={2}
        placeholder="Notes (optional)"
        value={form.notes}
        onChange={(e) => setForm({ ...form, notes: e.target.value })}
        className="w-full resize-none rounded-lg border border-border px-3 py-2 text-sm"
      />
      {contrastBlock && (
        <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm font-semibold text-red-800">
            Contrast allergy screen blocked this order
          </p>
          <ul className="list-disc pl-5 text-sm text-red-700">
            {contrastBlock.length === 0 && (
              <li>Contrast-relevant allergy conflict on record.</li>
            )}
            {contrastBlock.map((b, i) => (
              <li key={i}>
                {b.message ??
                  (b.type === "CONTRAST_ALLERGY_SCREEN_INCOMPLETE"
                    ? "Allergy screen could not complete — verify allergies manually."
                    : `Documented allergy: ${b.allergy ?? "contrast"} (${b.severity ?? "severity unknown"})`)}
              </li>
            ))}
          </ul>
          <textarea
            aria-label="Override reason"
            rows={2}
            placeholder="Override reason (minimum 5 characters, e.g. premedication given, allergy verified)"
            value={overrideReason}
            onChange={(e) => setOverrideReason(e.target.value)}
            className="w-full resize-none rounded-lg border border-red-300 px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => create.mutate(true)}
            disabled={create.isPending || overrideReason.trim().length < 5}
            className="w-full rounded-lg bg-red-600 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {create.isPending
              ? "Creating..."
              : "Acknowledge risk & create with override"}
          </button>
        </div>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={create.isPending}
        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        <Plus className="h-4 w-4" aria-hidden="true" />
        {create.isPending ? "Creating..." : "Create Order"}
      </button>
    </div>
  );
}

function PeerReviewTab() {
  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["radiology", "peer-reviews"],
    queryFn: async () =>
      unwrapList<PeerReviewRow>(
        await fetchAdminAPI<unknown>("/radiology/peer-reviews?limit=50"),
      ),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Peer Review Board</h2>
      {isLoading && (
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error
            ? error.message
            : "Failed to load peer-review board"}
        </div>
      )}
      {!isLoading && rows.length === 0 && !error && (
        <div className="py-12 text-center text-muted-foreground">
          No signed reports on the board
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2">Order</th>
                <th className="px-3 py-2">Modality</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Signed</th>
                <th className="px-3 py-2">Reviews</th>
                <th className="px-3 py-2">Max score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">{row.id}</td>
                  <td className="px-3 py-2">
                    {row.modality} {row.body_part || ""}
                  </td>
                  <td className="px-3 py-2">
                    <PriorityBadge priority={row.priority} />
                  </td>
                  <td className="px-3 py-2">
                    {fmtDateTime(row.report_signed_off_at)}
                  </td>
                  <td className="px-3 py-2">{row.review_count}</td>
                  <td className="px-3 py-2">
                    {row.max_discrepancy_score ?? "-"}
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

function TatTab() {
  const [breachedOnly, setBreachedOnly] = useState(false);
  const path = `/radiology/tat-metrics?limit=50${breachedOnly ? "&breached=true" : ""}`;
  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["radiology", "tat-metrics", breachedOnly],
    queryFn: async () =>
      unwrapList<TatMetric>(await fetchAdminAPI<unknown>(path)),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Turnaround Time</h2>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={breachedOnly}
            onChange={(e) => setBreachedOnly(e.target.checked)}
            className="h-4 w-4 rounded border-border"
          />
          Breached only
        </label>
      </div>
      {isLoading && (
        <div className="py-8 text-center text-muted-foreground">Loading...</div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {error instanceof Error
            ? error.message
            : "Failed to load TAT metrics"}
        </div>
      )}
      {!isLoading && rows.length === 0 && !error && (
        <div className="py-12 text-center text-muted-foreground">
          No TAT metrics found
        </div>
      )}
      {rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                <th className="px-3 py-2">Order</th>
                <th className="px-3 py-2">Modality</th>
                <th className="px-3 py-2">Priority</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2">Elapsed</th>
                <th className="px-3 py-2">Target</th>
                <th className="px-3 py-2">Alert</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.radiology_order_id}
                  className="border-b border-border hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {row.radiology_order_id}
                  </td>
                  <td className="px-3 py-2">
                    {row.modality} {row.body_part || ""}
                  </td>
                  <td className="px-3 py-2">
                    <PriorityBadge priority={row.priority} />
                  </td>
                  <td className="px-3 py-2">
                    {row.tat_stage.replaceAll("_", " ")}
                  </td>
                  <td className="px-3 py-2">
                    {fmtMinutes(row.current_elapsed_minutes)}
                  </td>
                  <td className="px-3 py-2">
                    {fmtMinutes(row.target_minutes)}
                  </td>
                  <td className="px-3 py-2">
                    {row.threshold_breached ? (
                      <span className="inline-flex rounded-full bg-red-100 px-2 py-1 text-xs font-medium text-red-800">
                        {row.alert_severity || "BREACHED"}
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-green-100 px-2 py-1 text-xs font-medium text-green-800">
                        On track
                      </span>
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

function RadiologyContent() {
  const [tab, setTab] = useState<ActiveTab>("worklist");
  const { connected, subscribed, lastEventAt } = useRealtimeInvalidation(
    RADIOLOGY_CHANNEL,
    [["radiology"]],
  );
  const liveLabel = subscribed
    ? "● Live"
    : connected
      ? "○ Connecting"
      : "○ Offline";
  const liveTitle = subscribed
    ? lastEventAt
      ? `Real-time via staff:radiology - last update ${new Date(lastEventAt).toLocaleTimeString()}`
      : "Real-time via staff:radiology"
    : connected
      ? "Connecting..."
      : "Offline - refresh manually";
  const tabs: { key: ActiveTab; label: string }[] = [
    { key: "worklist", label: "Worklist" },
    { key: "new", label: "New Order" },
    { key: "peerReview", label: "Peer Review" },
    { key: "tat", label: "TAT" },
  ];

  return (
    <div className="p-6">
      <div className="mb-6 flex items-center gap-2">
        <h1 className="text-3xl font-bold">Radiology</h1>
        <span
          data-testid="radiology-realtime-indicator"
          role="status"
          aria-label={
            subscribed
              ? "Live - real-time radiology updates active"
              : "Offline - real-time updates unavailable"
          }
          title={liveTitle}
          className={
            subscribed
              ? "text-xs font-medium text-green-600"
              : "text-xs font-medium text-gray-400"
          }
        >
          {liveLabel}
        </span>
      </div>
      <div className="mb-6 flex gap-1 rounded-lg bg-muted p-1">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${tab === key ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "worklist" && <WorklistTab />}
      {tab === "new" && <NewOrderTab />}
      {tab === "peerReview" && <PeerReviewTab />}
      {tab === "tat" && <TatTab />}
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
