"use client";

// NL-13 P4 — nuclear-medicine & radiotherapy COORDINATION (integrate-only) admin surface.
// Monitoring board for radiation-oncology referrals, external plan/fraction references,
// nuclear-medicine orders + radioisotope administration, and owner-sourced radiation-safety
// evidence, plus the per-tenant enablement toggle. Ships inert until an operator enables it.
// Image/document deep links reuse the existing PACS/OHIF viewer_url from the backend.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ClipboardList,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { fetchAdminAPI } from "@/lib/api";

type Settings = {
  enabled: boolean;
  aerb_evidence_owner?: string | null;
  owner_source_policy_ref?: string | null;
  planning_system_vendor_ref?: string | null;
  enabled_at?: string | null;
};

type Referral = {
  id: number;
  patient_uid: string;
  patient_name?: string | null;
  intent: string;
  modality: string;
  urgency: string;
  status: string;
  reason?: string | null;
  diagnosis_id?: number | null;
  staging_record_id?: number | null;
  plan_ref_count: number;
  nuclear_order_count: number;
  created_at: string;
};

type PlanRef = {
  id: number;
  external_plan_system?: string | null;
  external_plan_id?: string | null;
  plan_status: string;
  technique?: string | null;
  planned_fraction_count?: number | null;
  total_dose_gy_summary?: number | null;
  image_study_instance_uid?: string | null;
  viewer_url?: string | null;
};

type Fraction = {
  id: number;
  fraction_number: number;
  status: string;
  external_treatment_ref?: string | null;
  scheduled_at?: string | null;
  delivered_at?: string | null;
  hold_reason?: string | null;
  cancel_reason?: string | null;
};

type NuclearOrder = {
  id: number;
  order_kind: string;
  study_type: string;
  radiopharmaceutical_ref?: string | null;
  isotope_ref?: string | null;
  status: string;
  image_study_instance_uid?: string | null;
  viewer_url?: string | null;
};

type ReferralDetail = Referral & {
  plan_refs: PlanRef[];
  fraction_schedules: Fraction[];
  nuclear_medicine_orders: NuclearOrder[];
};

type SafetyEvidence = {
  id: number;
  evidence_type: string;
  title?: string | null;
  equipment_ref?: string | null;
  evidence_owner?: string | null;
  source_name?: string | null;
  source_version?: string | null;
  status: string;
  created_at: string;
};

type Tab = "referrals" | "safety-evidence";

function dateLabel(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Badge({ text }: { text: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
      {text.replace(/_/g, " ")}
    </span>
  );
}

export default function RadiationOncologyPage() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("referrals");
  const [selectedReferral, setSelectedReferral] = useState<number | null>(null);

  const settings = useQuery({
    queryKey: ["radiation-oncology", "settings"],
    queryFn: async () => {
      const data = await fetchAdminAPI<{ settings: Settings }>("/radiation-oncology/settings");
      return data.settings;
    },
  });

  const toggleEnabled = useMutation({
    mutationFn: async (enabled: boolean) =>
      fetchAdminAPI<{ settings: Settings }>("/radiation-oncology/settings", {
        method: "PATCH",
        body: { enabled },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["radiation-oncology"] }),
  });

  const referrals = useQuery({
    queryKey: ["radiation-oncology", "referrals"],
    queryFn: async () => {
      const data = await fetchAdminAPI<{ referrals: Referral[] }>("/radiation-oncology/referrals?limit=100");
      return data.referrals;
    },
  });

  const referralDetail = useQuery({
    queryKey: ["radiation-oncology", "referral", selectedReferral],
    enabled: selectedReferral !== null,
    queryFn: async () => {
      const data = await fetchAdminAPI<{ referral: ReferralDetail }>(`/radiation-oncology/referrals/${selectedReferral}`);
      return data.referral;
    },
  });

  const evidence = useQuery({
    queryKey: ["radiation-oncology", "safety-evidence"],
    enabled: tab === "safety-evidence",
    queryFn: async () => {
      const data = await fetchAdminAPI<{ evidence: SafetyEvidence[] }>("/radiation-oncology/safety-evidence?limit=100");
      return data.evidence;
    },
  });

  const enabled = settings.data?.enabled === true;

  return (
    <div className="space-y-6 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Nuclear Medicine &amp; Radiotherapy</h1>
          <p className="text-sm text-muted-foreground">
            Coordination only — external plan/delivery systems are integrated, never rebuilt. The product
            stores references and status; it never computes treatment plans or drives delivery.
          </p>
        </div>
        <button
          type="button"
          onClick={() => referrals.refetch()}
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {/* Per-tenant enablement */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-muted-foreground" />
            <div>
              <div className="font-medium">Suite enablement (per tenant)</div>
              <div className="text-sm text-muted-foreground">
                {settings.isLoading
                  ? "Loading…"
                  : enabled
                    ? `Enabled${settings.data?.enabled_at ? ` since ${dateLabel(settings.data.enabled_at)}` : ""}`
                    : "Disabled — the suite is inert until an operator enables it."}
              </div>
            </div>
          </div>
          <button
            type="button"
            disabled={settings.isLoading || toggleEnabled.isPending}
            onClick={() => toggleEnabled.mutate(!enabled)}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            {enabled ? <ToggleRight className="h-4 w-4 text-emerald-500" /> : <ToggleLeft className="h-4 w-4" />}
            {enabled ? "Disable" : "Enable"}
          </button>
        </div>
        {settings.error && (
          <div className="mt-3 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">
            {(settings.error as Error).message}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-border">
        {([
          ["referrals", "Referrals", ClipboardList],
          ["safety-evidence", "Safety Evidence", ShieldCheck],
        ] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium ${
              tab === key ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "referrals" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-4 py-2 text-sm font-medium">Radiation-oncology referrals</div>
            {referrals.isLoading && <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>}
            {referrals.error && (
              <div className="m-4 rounded border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
                {(referrals.error as Error).message}
              </div>
            )}
            {!referrals.isLoading && !referrals.error && (referrals.data?.length ?? 0) === 0 && (
              <div className="p-8 text-center text-sm text-muted-foreground">No radiation-oncology referrals.</div>
            )}
            <ul className="divide-y divide-border">
              {(referrals.data ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedReferral(r.id)}
                    className={`flex w-full flex-col gap-1 px-4 py-3 text-left hover:bg-muted ${selectedReferral === r.id ? "bg-muted" : ""}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{r.patient_name || r.patient_uid.slice(0, 8)}</span>
                      <Badge text={r.status} />
                    </div>
                    <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <Badge text={r.modality} />
                      <Badge text={r.intent} />
                      <span>{r.plan_ref_count} plan ref(s)</span>
                      <span>{r.nuclear_order_count} NM order(s)</span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-lg border border-border">
            <div className="border-b border-border px-4 py-2 text-sm font-medium">Referral detail</div>
            {selectedReferral === null && (
              <div className="p-8 text-center text-sm text-muted-foreground">Select a referral to see plan references, fraction status, and nuclear-medicine orders.</div>
            )}
            {selectedReferral !== null && referralDetail.isLoading && (
              <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
            )}
            {selectedReferral !== null && referralDetail.error && (
              <div className="m-4 rounded border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
                {(referralDetail.error as Error).message}
              </div>
            )}
            {selectedReferral !== null && referralDetail.data && (
              <div className="space-y-4 p-4 text-sm">
                <section>
                  <div className="mb-1 font-medium">Plan references</div>
                  {referralDetail.data.plan_refs.length === 0 && <div className="text-muted-foreground">No external plan references.</div>}
                  <ul className="space-y-2">
                    {referralDetail.data.plan_refs.map((p) => (
                      <li key={p.id} className="rounded border border-border p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span>{p.external_plan_system || "—"} · {p.external_plan_id || "no ref"}</span>
                          <Badge text={p.plan_status} />
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {p.technique && <span>{p.technique}</span>}
                          {p.planned_fraction_count != null && <span>{p.planned_fraction_count} fractions (owner)</span>}
                          {p.total_dose_gy_summary != null && <span>{p.total_dose_gy_summary} Gy (owner)</span>}
                          {p.viewer_url && (
                            <a href={p.viewer_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <ExternalLink className="h-3 w-3" /> Viewer
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>

                <section>
                  <div className="mb-1 font-medium">Fraction status</div>
                  {referralDetail.data.fraction_schedules.length === 0 && <div className="text-muted-foreground">No fractions scheduled.</div>}
                  <ul className="space-y-1">
                    {referralDetail.data.fraction_schedules.map((f) => (
                      <li key={f.id} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1">
                        <span>Fraction #{f.fraction_number}{f.external_treatment_ref ? ` · ${f.external_treatment_ref}` : ""}</span>
                        <Badge text={f.status} />
                      </li>
                    ))}
                  </ul>
                </section>

                <section>
                  <div className="mb-1 font-medium">Nuclear-medicine orders</div>
                  {referralDetail.data.nuclear_medicine_orders.length === 0 && <div className="text-muted-foreground">No nuclear-medicine orders.</div>}
                  <ul className="space-y-2">
                    {referralDetail.data.nuclear_medicine_orders.map((o) => (
                      <li key={o.id} className="rounded border border-border p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span>{o.study_type} ({o.order_kind})</span>
                          <Badge text={o.status} />
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                          {(o.radiopharmaceutical_ref || o.isotope_ref) && <span>{o.radiopharmaceutical_ref || o.isotope_ref}</span>}
                          {o.viewer_url && (
                            <a href={o.viewer_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                              <ExternalLink className="h-3 w-3" /> Viewer
                            </a>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "safety-evidence" && (
        <div className="rounded-lg border border-border">
          <div className="border-b border-border px-4 py-2 text-sm font-medium">
            Radiation-safety evidence register (owner-sourced · equipment/QA audit trail)
          </div>
          {evidence.isLoading && <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>}
          {evidence.error && (
            <div className="m-4 rounded border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
              {(evidence.error as Error).message}
            </div>
          )}
          {!evidence.isLoading && !evidence.error && (evidence.data?.length ?? 0) === 0 && (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No radiation-safety evidence recorded. Owner-sourced AERB/QA evidence stays inert until the operator supplies it.
            </div>
          )}
          <ul className="divide-y divide-border">
            {(evidence.data ?? []).map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="flex flex-col">
                  <span className="font-medium">{e.title || e.equipment_ref || "Radiation-safety evidence"}</span>
                  <span className="text-xs text-muted-foreground">
                    {e.evidence_type.replace(/_/g, " ")}
                    {e.evidence_owner ? ` · owner: ${e.evidence_owner}` : ""}
                    {e.source_version ? ` · ${e.source_name || "source"} ${e.source_version}` : ""}
                  </span>
                </div>
                <Badge text={e.status} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
