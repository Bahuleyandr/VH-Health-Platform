// src/app/(with-auth)/dashboard/microbiology/page.tsx
//
// Sprint 17 — Microbiology orders + isolates + antibiogram + resistance
// dashboard.

"use client";

import { useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

type Tab = "orders" | "antibiogram" | "resistance";

interface MicroOrder {
  id: number;
  patient_uid: string;
  specimen_type: string;
  specimen_site: string | null;
  test_kind: string;
  status: string;
  growth_status: string | null;
  ordered_by_name: string | null;
  finalised_at: string | null;
  created_at: string;
}

interface AntibiogramRow {
  organism_name: string;
  antibiotic_code: string;
  antibiotic_name: string;
  total_tested: number;
  susceptible_count: number;
  susceptible_pct: number | null;
}

interface ResistantIsolateRow {
  id: number;
  order_id: number;
  organism_name: string;
  colony_count: string | null;
  is_mrsa: boolean;
  is_esbl: boolean;
  is_amp_c: boolean;
  is_carbapenemase: boolean;
  is_vre: boolean;
  is_xdr: boolean;
  patient_uid: string;
  specimen_type: string;
  specimen_site: string | null;
  created_at: string;
}

const STATUS_COLOURS: Record<string, string> = {
  pending: "bg-slate-100 text-slate-700",
  collected: "bg-blue-100 text-blue-800",
  received: "bg-blue-200 text-blue-900",
  in_progress: "bg-amber-100 text-amber-800",
  preliminary: "bg-amber-200 text-amber-900",
  final: "bg-emerald-100 text-emerald-800",
  cancelled: "bg-rose-100 text-rose-800",
};

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export default function MicrobiologyPage() {
  const [tab, setTab] = useState<Tab>("orders");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-1">Microbiology</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Cultures, antibiograms, and antimicrobial resistance dashboard.
      </p>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
        {(
          [
            { key: "orders", label: "🧫 Orders" },
            { key: "antibiogram", label: "📊 Antibiogram (90d)" },
            { key: "resistance", label: "🚨 Resistance (30d)" },
          ] as { key: Tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "orders" && <OrdersTab />}
      {tab === "antibiogram" && <AntibiogramTab />}
      {tab === "resistance" && <ResistanceTab />}
    </div>
  );
}

function OrdersTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [openOrder, setOpenOrder] = useState<number | null>(null);

  const { data: rows = [], error, isLoading } = useQuery<MicroOrder[]>({
    queryKey: ["micro", "orders", { statusFilter }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetchAdminAPI<unknown>(
        `/microbiology/orders?${params.toString()}`,
      );
      return unwrapList<MicroOrder>(r);
    },
  });

  const errMsg = error?.toString();

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Status</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {Object.keys(STATUS_COLOURS).map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          + New culture order
        </button>
        <div className="flex-1" />
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["micro"] })}
          className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
        >
          Refresh
        </button>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No orders" description="No micro orders match this filter." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Order #</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Specimen</th>
                <th className="px-3 py-2">Test</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Growth</th>
                <th className="px-3 py-2">Ordered</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => (
                <tr key={o.id} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="px-3 py-2 font-mono text-xs">#{o.id}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {o.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{o.specimen_type}</div>
                    {o.specimen_site && (
                      <div className="text-muted-foreground">{o.specimen_site}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">{o.test_kind}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[o.status] ?? ""
                      }`}
                    >
                      {o.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {o.growth_status?.replace(/_/g, " ") ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtTs(o.created_at)}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setOpenOrder(o.id)}
                      className="px-2 py-1 rounded border text-xs hover:bg-muted"
                    >
                      Open →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateOrderModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["micro", "orders"] });
          }}
        />
      )}
      {openOrder !== null && (
        <OrderDetailModal
          orderId={openOrder}
          onClose={() => setOpenOrder(null)}
        />
      )}
    </div>
  );
}

function CreateOrderModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    patient_uid: "",
    specimen_type: "blood",
    specimen_site: "",
    test_kind: "culture_sensitivity",
    clinical_notes: "",
  });
  const mut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/microbiology/orders", {
        method: "POST",
        body: JSON.stringify(form),
      }),
    onSuccess: onCreated,
  });
  const errMsg = mut.error instanceof Error ? mut.error.message : null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">New culture order</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Patient UID *</label>
            <input
              value={form.patient_uid}
              onChange={(e) => setForm({ ...form, patient_uid: e.target.value })}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Specimen *</label>
              <select
                value={form.specimen_type}
                onChange={(e) => setForm({ ...form, specimen_type: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              >
                {["blood", "urine", "sputum", "pus", "csf", "stool", "wound", "et_secretion", "tip", "other"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Test kind</label>
              <select
                value={form.test_kind}
                onChange={(e) => setForm({ ...form, test_kind: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              >
                {["culture_sensitivity", "gram_stain", "afb_smear", "afb_culture", "fungal_culture", "mrsa_screen", "esbl_screen", "cre_screen", "kpc_screen"].map((s) => (
                  <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Site</label>
            <input
              value={form.specimen_site}
              onChange={(e) => setForm({ ...form, specimen_site: e.target.value })}
              placeholder="e.g. central line tip / left ankle wound"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Clinical notes</label>
            <textarea
              value={form.clinical_notes}
              onChange={(e) => setForm({ ...form, clinical_notes: e.target.value })}
              rows={3}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md border text-sm hover:bg-muted">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !form.patient_uid}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {mut.isPending ? "Creating…" : "Create order"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface OrderDetail extends MicroOrder {
  isolates: Array<{
    id: number;
    organism_name: string;
    colony_count: string | null;
    is_mrsa: boolean;
    is_esbl: boolean;
    is_amp_c: boolean;
    is_carbapenemase: boolean;
    is_vre: boolean;
    is_xdr: boolean;
    sensitivities: Array<{
      id: number;
      antibiotic_code: string;
      antibiotic_name: string;
      result: string;
      mic_value: number | null;
      mic_unit: string | null;
      method: string | null;
    }>;
  }>;
}

function OrderDetailModal({
  orderId, onClose,
}: {
  orderId: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: detail, isLoading } = useQuery<OrderDetail>({
    queryKey: ["micro", "order", orderId],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(`/microbiology/orders/${orderId}`);
      return ((r as { data?: OrderDetail }).data ?? r) as OrderDetail;
    },
  });

  const transitionMut = useMutation({
    mutationFn: async (vars: { status: string; growth_status?: string }) =>
      fetchAdminAPI(`/microbiology/orders/${orderId}/transition`, {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["micro"] }),
  });

  const allowedNext: Record<string, string[]> = {
    pending: ["collected"],
    collected: ["received"],
    received: ["in_progress"],
    in_progress: ["preliminary", "final"],
    preliminary: ["final"],
  };

  function transition(status: string) {
    if (status === "final") {
      const growth = window.prompt(
        "Growth status (no_growth / normal_flora / pathogen_isolated / mixed_growth / contaminated):",
        "pathogen_isolated",
      );
      if (!growth) return;
      transitionMut.mutate({ status, growth_status: growth });
      return;
    }
    transitionMut.mutate({ status });
  }

  function addIsolate() {
    const name = window.prompt("Organism name (e.g. Escherichia coli):");
    if (!name) return;
    fetchAdminAPI(`/microbiology/orders/${orderId}/isolates`, {
      method: "POST",
      body: JSON.stringify({ organism_name: name }),
    }).then(() => qc.invalidateQueries({ queryKey: ["micro", "order", orderId] }));
  }

  function addSensitivity(isolateId: number) {
    const code = window.prompt("Antibiotic code (e.g. CIP for ciprofloxacin):");
    if (!code) return;
    const name = window.prompt(`Antibiotic name for ${code}:`);
    if (!name) return;
    const result = window.prompt(
      "Result (S = susceptible, I = intermediate, R = resistant):",
      "S",
    );
    if (!result) return;
    fetchAdminAPI(`/microbiology/isolates/${isolateId}/sensitivities`, {
      method: "POST",
      body: JSON.stringify({
        antibiotic_code: code,
        antibiotic_name: name,
        result: result.toUpperCase(),
      }),
    }).then(() => qc.invalidateQueries({ queryKey: ["micro", "order", orderId] }));
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-3xl mb-8">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Micro order #{orderId}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-4">
          {isLoading || !detail ? (
            <LoadingSpinner />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3 text-sm flex-wrap">
                <span
                  className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                    STATUS_COLOURS[detail.status] ?? ""
                  }`}
                >
                  {detail.status.replace(/_/g, " ")}
                </span>
                <span className="text-muted-foreground">
                  {detail.specimen_type}
                  {detail.specimen_site ? ` · ${detail.specimen_site}` : ""}
                </span>
                <span className="text-muted-foreground">{detail.test_kind}</span>
              </div>

              {/* Workflow buttons */}
              <div className="flex gap-1 flex-wrap">
                {(allowedNext[detail.status] ?? []).map((s) => (
                  <button
                    key={s}
                    onClick={() => transition(s)}
                    disabled={transitionMut.isPending}
                    className="px-2 py-1 rounded bg-blue-600 text-white text-xs disabled:opacity-40"
                  >
                    → {s.replace(/_/g, " ")}
                  </button>
                ))}
              </div>

              {/* Isolates */}
              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold">
                    Isolates ({detail.isolates.length})
                  </h3>
                  <button
                    onClick={addIsolate}
                    className="px-2 py-1 rounded border text-xs hover:bg-muted"
                  >
                    + Add isolate
                  </button>
                </div>
                {detail.isolates.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No isolates recorded yet.</p>
                ) : (
                  <div className="space-y-3">
                    {detail.isolates.map((iso) => (
                      <div key={iso.id} className="border rounded p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="font-medium">{iso.organism_name}</p>
                            {iso.colony_count && (
                              <p className="text-xs text-muted-foreground">
                                {iso.colony_count}
                              </p>
                            )}
                            <div className="flex gap-1 flex-wrap mt-1">
                              {iso.is_mrsa && <ResistancePill label="MRSA" />}
                              {iso.is_esbl && <ResistancePill label="ESBL" />}
                              {iso.is_amp_c && <ResistancePill label="AmpC" />}
                              {iso.is_carbapenemase && <ResistancePill label="Carbapenemase" />}
                              {iso.is_vre && <ResistancePill label="VRE" />}
                              {iso.is_xdr && <ResistancePill label="XDR" />}
                            </div>
                          </div>
                          <button
                            onClick={() => addSensitivity(iso.id)}
                            className="px-2 py-1 rounded border text-xs hover:bg-muted"
                          >
                            + Sensitivity
                          </button>
                        </div>

                        {iso.sensitivities.length > 0 && (
                          <table className="min-w-full text-xs mt-3">
                            <thead className="text-muted-foreground border-b">
                              <tr className="text-left">
                                <th className="py-1">Antibiotic</th>
                                <th className="py-1">Result</th>
                                <th className="py-1">MIC</th>
                                <th className="py-1">Method</th>
                              </tr>
                            </thead>
                            <tbody>
                              {iso.sensitivities.map((s) => (
                                <tr key={s.id} className="border-b last:border-0">
                                  <td className="py-1">
                                    <span className="font-mono">{s.antibiotic_code}</span>
                                    <span className="text-muted-foreground"> · {s.antibiotic_name}</span>
                                  </td>
                                  <td className="py-1">
                                    <span
                                      className={`inline-block px-1.5 py-0 rounded font-bold ${
                                        s.result === "S"
                                          ? "bg-emerald-100 text-emerald-800"
                                          : s.result === "R"
                                            ? "bg-rose-100 text-rose-800"
                                            : "bg-amber-100 text-amber-800"
                                      }`}
                                    >
                                      {s.result}
                                    </span>
                                  </td>
                                  <td className="py-1 font-mono">
                                    {s.mic_value != null ? `${s.mic_value} ${s.mic_unit ?? ""}` : "—"}
                                  </td>
                                  <td className="py-1 text-muted-foreground">{s.method ?? "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ResistancePill({ label }: { label: string }) {
  return (
    <span className="inline-block px-1.5 py-0.5 rounded bg-rose-200 text-rose-900 text-[10px] font-bold">
      {label}
    </span>
  );
}

function AntibiogramTab() {
  const [organism, setOrganism] = useState("");
  const [antibiotic, setAntibiotic] = useState("");
  const { data: rows = [], isLoading, error } = useQuery<AntibiogramRow[]>({
    queryKey: ["micro", "antibiogram", { organism, antibiotic }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (organism) params.set("organism", organism);
      if (antibiotic) params.set("antibiotic", antibiotic);
      const r = await fetchAdminAPI<unknown>(
        `/microbiology/antibiogram?${params.toString()}`,
      );
      return unwrapList<AntibiogramRow>(r);
    },
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Susceptibility patterns over the last 90 days. Min sample n=5 to suppress
        small-sample noise. Drives empirical antibiotic guidance for the
        antimicrobial stewardship committee.
      </p>
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Organism</label>
          <input
            value={organism}
            onChange={(e) => setOrganism(e.target.value)}
            placeholder="E. coli / Klebsiella / S. aureus"
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Antibiotic</label>
          <input
            value={antibiotic}
            onChange={(e) => setAntibiotic(e.target.value)}
            placeholder="ceftriaxone / meropenem"
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {(error as Error).message}
        </div>
      )}
      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No data"
          description="No antibiogram entries match (or sample size is below 5)."
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Organism</th>
                <th className="px-3 py-2">Antibiotic</th>
                <th className="px-3 py-2 text-right">n</th>
                <th className="px-3 py-2 text-right">Susceptible</th>
                <th className="px-3 py-2 text-right">% S</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pct = r.susceptible_pct ?? 0;
                const colour =
                  pct >= 80
                    ? "bg-emerald-100 text-emerald-800"
                    : pct >= 50
                      ? "bg-amber-100 text-amber-800"
                      : "bg-rose-100 text-rose-800";
                return (
                  <tr
                    key={`${r.organism_name}-${r.antibiotic_code}`}
                    className="border-b last:border-0 hover:bg-muted/40"
                  >
                    <td className="px-3 py-2">{r.organism_name}</td>
                    <td className="px-3 py-2 text-xs">
                      <div>{r.antibiotic_name}</div>
                      <div className="text-muted-foreground font-mono">{r.antibiotic_code}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-right">{r.total_tested}</td>
                    <td className="px-3 py-2 font-mono text-right">{r.susceptible_count}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block px-2 py-0.5 rounded font-mono ${colour}`}>
                        {pct.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div
                        className="bg-muted rounded-full h-2 w-24 overflow-hidden"
                        title={`${pct.toFixed(1)}% susceptible`}
                      >
                        <div
                          className={
                            pct >= 80 ? "bg-emerald-500 h-full" : pct >= 50 ? "bg-amber-500 h-full" : "bg-rose-500 h-full"
                          }
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ResistanceTab() {
  const { data: rows = [], isLoading, error } = useQuery<ResistantIsolateRow[]>({
    queryKey: ["micro", "resistant"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/microbiology/resistant-isolates?limit=100",
      );
      return unwrapList<ResistantIsolateRow>(r);
    },
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Multi-drug resistant isolates from the last 30 days. Infection control
        uses this for contact precautions + outbreak surveillance.
      </p>
      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {(error as Error).message}
        </div>
      )}
      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="All clear" description="No resistant organisms in the last 30 days." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Specimen</th>
                <th className="px-3 py-2">Organism</th>
                <th className="px-3 py-2">Resistance markers</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b last:border-0 bg-rose-50/30"
                >
                  <td className="px-3 py-2 text-xs">{fmtTs(r.created_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {r.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{r.specimen_type}</div>
                    {r.specimen_site && (
                      <div className="text-muted-foreground">{r.specimen_site}</div>
                    )}
                  </td>
                  <td className="px-3 py-2">{r.organism_name}</td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 flex-wrap">
                      {r.is_mrsa && <ResistancePill label="MRSA" />}
                      {r.is_esbl && <ResistancePill label="ESBL" />}
                      {r.is_amp_c && <ResistancePill label="AmpC" />}
                      {r.is_carbapenemase && <ResistancePill label="Carbapenemase" />}
                      {r.is_vre && <ResistancePill label="VRE" />}
                      {r.is_xdr && <ResistancePill label="XDR" />}
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
