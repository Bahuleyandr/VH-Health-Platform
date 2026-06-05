// src/app/(with-auth)/dashboard/pmjay/page.tsx
//
// Sprint 16 — AB-PMJAY / state-scheme insurance coordinator desk.

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

type Tab = "cases" | "beneficiaries" | "packages";

interface Case {
  id: number;
  case_number: string;
  patient_uid: string;
  primary_diagnosis: string;
  locked_package_rate: number | string;
  approved_amount: number | string | null;
  paid_amount: number | string | null;
  status: string;
  preauth_submitted_at: string | null;
  claim_submitted_at: string | null;
  scheme_code: string;
  package_code: string;
  procedure_name: string;
}

interface Beneficiary {
  id: number;
  patient_uid: string;
  scheme_code: string;
  beneficiary_id: string;
  family_id: string | null;
  card_number: string | null;
  policyholder_name: string | null;
  policy_year: string | null;
  state_code: string | null;
  age_eligible: boolean;
  verified_at: string | null;
  verification_method: string | null;
  cumulative_used: number | string | null;
}

interface PmjayPackage {
  id: number;
  scheme_code: string;
  package_code: string;
  procedure_name: string;
  specialty_group: string | null;
  package_rate: number | string;
  los_days: number | null;
  inclusions: string | null;
  exclusions: string | null;
  bundling_allowed: boolean;
}

const STATUS_COLOURS: Record<string, string> = {
  preauth_draft: "bg-slate-100 text-slate-700",
  preauth_submitted: "bg-blue-100 text-blue-800",
  preauth_queried: "bg-amber-100 text-amber-800",
  preauth_approved: "bg-emerald-100 text-emerald-800",
  preauth_denied: "bg-rose-100 text-rose-800",
  admission_in_progress: "bg-blue-200 text-blue-900",
  discharge_pending: "bg-amber-100 text-amber-800",
  claim_submitted: "bg-blue-100 text-blue-800",
  claim_queried: "bg-amber-100 text-amber-800",
  claim_approved: "bg-emerald-100 text-emerald-800",
  claim_denied: "bg-rose-100 text-rose-800",
  claim_paid: "bg-emerald-200 text-emerald-900",
  claim_closed: "bg-slate-200 text-slate-600",
  cancelled: "bg-rose-200 text-rose-900",
};

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

function fmtINR(n: number | string | null | undefined): string {
  const num = Number(n ?? 0);
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(num);
}

export default function PmjayPage() {
  const [tab, setTab] = useState<Tab>("cases");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-1">
        AB-PMJAY / Government Schemes
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        Beneficiary verification → fixed-rate package pre-auth → claim
        settlement. Different model from private TPA claims (which live under
        Insurance).
      </p>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit">
        {(
          [
            { key: "cases", label: "📋 Cases" },
            { key: "beneficiaries", label: "🪪 Beneficiaries" },
            { key: "packages", label: "📦 HBP packages" },
          ] as { key: Tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === key
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "cases" && <CasesTab />}
      {tab === "beneficiaries" && <BeneficiariesTab />}
      {tab === "packages" && <PackagesTab />}
    </div>
  );
}

function CasesTab() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("");
  const [openCase, setOpenCase] = useState<number | null>(null);

  const {
    data: rows = [],
    error,
    isLoading,
  } = useQuery<Case[]>({
    queryKey: ["pmjay", "cases", { statusFilter }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetchAdminAPI<unknown>(
        `/pmjay/cases?${params.toString()}`,
      );
      return unwrapList<Case>(r);
    },
  });

  const transitionMut = useMutation({
    mutationFn: async (vars: {
      id: number;
      status: string;
      scheme_reference_id?: string;
      query_text?: string;
      denial_reason?: string;
      approved_amount?: number;
      paid_amount?: number;
      payment_reference?: string;
    }) =>
      fetchAdminAPI(`/pmjay/cases/${vars.id}/transition`, {
        method: "POST",
        body: vars,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pmjay"] }),
  });

  function transition(c: Case, status: string) {
    if (status === "preauth_submitted") {
      const ref = window.prompt(
        `PMJAY portal reference id (optional) for ${c.case_number}:`,
        "",
      );
      if (ref === null) return;
      transitionMut.mutate({
        id: c.id,
        status,
        scheme_reference_id: ref || undefined,
      });
      return;
    }
    if (status === "preauth_approved" || status === "claim_approved") {
      const amt = window.prompt(
        `Approved amount for ${c.case_number} (locked rate ${fmtINR(c.locked_package_rate)}):`,
        String(c.locked_package_rate),
      );
      if (amt === null) return;
      transitionMut.mutate({ id: c.id, status, approved_amount: Number(amt) });
      return;
    }
    if (status === "preauth_queried" || status === "claim_queried") {
      const q = window.prompt("Query text:", "");
      if (q === null) return;
      transitionMut.mutate({ id: c.id, status, query_text: q });
      return;
    }
    if (status === "preauth_denied" || status === "claim_denied") {
      const reason = window.prompt("Denial reason:", "");
      if (reason === null) return;
      transitionMut.mutate({ id: c.id, status, denial_reason: reason });
      return;
    }
    if (status === "claim_paid") {
      const amt = window.prompt(
        `Paid amount for ${c.case_number}:`,
        String(c.approved_amount ?? c.locked_package_rate),
      );
      if (amt === null) return;
      const ref = window.prompt("Payment reference (UTR):", "");
      if (ref === null) return;
      transitionMut.mutate({
        id: c.id,
        status,
        paid_amount: Number(amt),
        payment_reference: ref || undefined,
      });
      return;
    }
    transitionMut.mutate({ id: c.id, status });
  }

  // Allowed transitions match backend STATUS_TRANSITIONS map.
  const allowedNextStatuses: Record<string, string[]> = {
    preauth_draft: ["preauth_submitted", "cancelled"],
    preauth_submitted: [
      "preauth_approved",
      "preauth_queried",
      "preauth_denied",
      "cancelled",
    ],
    preauth_queried: ["preauth_submitted", "preauth_denied", "cancelled"],
    preauth_approved: ["admission_in_progress", "cancelled"],
    admission_in_progress: ["discharge_pending", "cancelled"],
    discharge_pending: ["claim_submitted", "cancelled"],
    claim_submitted: ["claim_approved", "claim_queried", "claim_denied"],
    claim_queried: ["claim_submitted", "claim_denied"],
    claim_approved: ["claim_paid", "claim_denied"],
    claim_paid: ["claim_closed"],
    claim_denied: ["claim_closed"],
  };

  const errMsg = (error ?? transitionMut.error)?.toString();

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Status
          </label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All</option>
            {Object.keys(STATUS_COLOURS).map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={() => setOpenCase(-1)}
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          + New case
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
        <EmptyState
          title="No cases"
          description="No PMJAY cases match this filter."
        />
      ) : (
        <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Case #</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Scheme / Package</th>
                <th className="px-3 py-2">Diagnosis</th>
                <th className="px-3 py-2">Locked rate</th>
                <th className="px-3 py-2">Approved</th>
                <th className="px-3 py-2">Paid</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr
                  key={c.id}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {c.case_number}
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    {c.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{c.scheme_code}</div>
                    <div className="text-muted-foreground font-mono">
                      {c.package_code}
                    </div>
                    <div className="text-muted-foreground">
                      {c.procedure_name}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs max-w-xs truncate">
                    {c.primary_diagnosis}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {fmtINR(c.locked_package_rate)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {c.approved_amount != null
                      ? fmtINR(c.approved_amount)
                      : "—"}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {c.paid_amount != null ? fmtINR(c.paid_amount) : "—"}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[c.status] ?? ""
                      }`}
                    >
                      {c.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 space-x-1 text-xs">
                    {(allowedNextStatuses[c.status] ?? []).map((s) => (
                      <button
                        key={s}
                        disabled={transitionMut.isPending}
                        onClick={() => transition(c, s)}
                        className={`px-2 py-1 rounded text-white disabled:opacity-40 ${
                          s.includes("denied") || s === "cancelled"
                            ? "bg-rose-600"
                            : s.includes("queried")
                              ? "bg-amber-600"
                              : s.includes("approved") || s === "claim_paid"
                                ? "bg-emerald-600"
                                : "bg-blue-600"
                        }`}
                      >
                        → {s.replace(/_/g, " ")}
                      </button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openCase === -1 && (
        <NewCaseModal
          onClose={() => setOpenCase(null)}
          onCreated={() => {
            setOpenCase(null);
            qc.invalidateQueries({ queryKey: ["pmjay", "cases"] });
          }}
        />
      )}
    </div>
  );
}

function NewCaseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    patient_uid: "",
    beneficiary_id: 0,
    package_id: 0,
    primary_diagnosis: "",
    treating_doctor_name: "",
    expected_admission_date: "",
  });

  const [pkgQuery, setPkgQuery] = useState("");
  const { data: beneficiaries = [] } = useQuery<Beneficiary[]>({
    queryKey: ["pmjay", "beneficiaries", "patient", form.patient_uid],
    queryFn: async () => {
      if (!form.patient_uid) return [];
      const r = await fetchAdminAPI<unknown>(
        `/pmjay/beneficiaries/patient/${encodeURIComponent(form.patient_uid)}`,
      );
      return unwrapList<Beneficiary>(r);
    },
    enabled: !!form.patient_uid,
  });
  const { data: packages = [] } = useQuery<PmjayPackage[]>({
    queryKey: ["pmjay", "packages", { pkgQuery }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "30" });
      if (pkgQuery) params.set("q", pkgQuery);
      const r = await fetchAdminAPI<unknown>(
        `/pmjay/packages?${params.toString()}`,
      );
      return unwrapList<PmjayPackage>(r);
    },
    enabled: pkgQuery.length >= 2,
  });

  const createMut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/pmjay/cases", {
        method: "POST",
        body: {
          patient_uid: form.patient_uid,
          beneficiary_id: form.beneficiary_id,
          package_id: form.package_id,
          primary_diagnosis: form.primary_diagnosis,
          treating_doctor_name: form.treating_doctor_name || undefined,
          expected_admission_date: form.expected_admission_date || undefined,
        },
      }),
    onSuccess: onCreated,
  });

  const errMsg =
    createMut.error instanceof Error ? createMut.error.message : null;
  const verifiedBeneficiary = beneficiaries.find(
    (b) => b.id === form.beneficiary_id && b.verified_at,
  );

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-card rounded-lg shadow-lg w-full max-w-2xl mb-8">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">New PMJAY case</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Patient UID *
            </label>
            <input
              value={form.patient_uid}
              onChange={(e) =>
                setForm({
                  ...form,
                  patient_uid: e.target.value,
                  beneficiary_id: 0,
                })
              }
              placeholder="UUID"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
          {form.patient_uid && (
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Beneficiary (must be verified)
              </label>
              {beneficiaries.length === 0 ? (
                <p className="text-xs text-amber-700">
                  No beneficiaries linked to this patient. Add one in the
                  Beneficiaries tab first.
                </p>
              ) : (
                <select
                  value={form.beneficiary_id || ""}
                  onChange={(e) =>
                    setForm({ ...form, beneficiary_id: Number(e.target.value) })
                  }
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Select beneficiary…</option>
                  {beneficiaries.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.scheme_code} · {b.beneficiary_id}
                      {b.verified_at ? " ✓" : " (unverified)"}
                      {b.policyholder_name ? ` — ${b.policyholder_name}` : ""}
                    </option>
                  ))}
                </select>
              )}
              {form.beneficiary_id > 0 && !verifiedBeneficiary && (
                <p className="text-xs text-rose-700 mt-1">
                  This beneficiary is not verified. Verify (OTP / biometric) in
                  the Beneficiaries tab before creating a case.
                </p>
              )}
            </div>
          )}
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              HBP package * (search by procedure or code)
            </label>
            <input
              value={pkgQuery}
              onChange={(e) => setPkgQuery(e.target.value)}
              placeholder="cataract / CABG / GS-15-…"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm mb-2"
            />
            {pkgQuery.length >= 2 && (
              <div className="max-h-40 overflow-y-auto border rounded">
                {packages.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setForm({ ...form, package_id: p.id })}
                    className={`w-full text-left px-2 py-1.5 text-xs hover:bg-muted/30 ${
                      form.package_id === p.id ? "bg-blue-50" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono">{p.package_code}</span>
                      <span className="font-mono">
                        {fmtINR(p.package_rate)}
                      </span>
                    </div>
                    <div>{p.procedure_name}</div>
                    {p.specialty_group && (
                      <div className="text-muted-foreground">
                        {p.specialty_group}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Primary diagnosis *
            </label>
            <input
              value={form.primary_diagnosis}
              onChange={(e) =>
                setForm({ ...form, primary_diagnosis: e.target.value })
              }
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Treating doctor (name)
              </label>
              <input
                value={form.treating_doctor_name}
                onChange={(e) =>
                  setForm({ ...form, treating_doctor_name: e.target.value })
                }
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Expected admission date
              </label>
              <input
                type="date"
                value={form.expected_admission_date}
                onChange={(e) =>
                  setForm({ ...form, expected_admission_date: e.target.value })
                }
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          </div>
          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => createMut.mutate()}
            disabled={
              createMut.isPending ||
              !form.patient_uid ||
              !form.beneficiary_id ||
              !form.package_id ||
              !form.primary_diagnosis ||
              !verifiedBeneficiary
            }
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {createMut.isPending ? "Creating…" : "Create draft"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BeneficiariesTab() {
  const qc = useQueryClient();
  const [patientUid, setPatientUid] = useState("");
  const [submittedUid, setSubmittedUid] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<Beneficiary[]>({
    queryKey: ["pmjay", "beneficiaries", "patient", submittedUid],
    queryFn: async () => {
      if (!submittedUid) return [];
      const r = await fetchAdminAPI<unknown>(
        `/pmjay/beneficiaries/patient/${encodeURIComponent(submittedUid)}`,
      );
      return unwrapList<Beneficiary>(r);
    },
    enabled: !!submittedUid,
  });

  const verifyMut = useMutation({
    mutationFn: async (vars: { id: number; method: string }) =>
      fetchAdminAPI(`/pmjay/beneficiaries/${vars.id}/verify`, {
        method: "POST",
        body: { verification_method: vars.method },
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["pmjay", "beneficiaries"] }),
  });

  function verify(b: Beneficiary) {
    const method = window.prompt(
      `Verification method for ${b.scheme_code} ${b.beneficiary_id}:\n` +
        `• otp\n• aadhaar_biometric\n• card_match\n• manual`,
      "otp",
    );
    if (!method) return;
    verifyMut.mutate({ id: b.id, method });
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setSubmittedUid(patientUid.trim());
        }}
        className="flex gap-3 items-end flex-wrap"
      >
        <div className="flex-1 min-w-[280px]">
          <label className="text-xs text-muted-foreground block mb-1">
            Patient UID
          </label>
          <input
            value={patientUid}
            onChange={(e) => setPatientUid(e.target.value)}
            placeholder="UUID"
            className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
          />
        </div>
        <button
          type="submit"
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          Fetch
        </button>
        {submittedUid && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            + Link beneficiary
          </button>
        )}
      </form>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {(error as Error).message}
        </div>
      )}

      {!submittedUid ? (
        <EmptyState
          title="Enter a patient UID"
          description="Look up linked PMJAY / scheme beneficiaries."
        />
      ) : isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No beneficiaries linked"
          description="Click 'Link beneficiary' to add one."
        />
      ) : (
        <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Scheme</th>
                <th className="px-3 py-2">Beneficiary ID</th>
                <th className="px-3 py-2">Holder</th>
                <th className="px-3 py-2">State</th>
                <th className="px-3 py-2">Policy year</th>
                <th className="px-3 py-2">Cumulative used</th>
                <th className="px-3 py-2">Verified</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.id}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {b.scheme_code}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {b.beneficiary_id}
                    {b.family_id && (
                      <div className="text-muted-foreground">
                        family {b.family_id}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {b.policyholder_name ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-xs">{b.state_code ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{b.policy_year ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {b.cumulative_used != null
                      ? fmtINR(b.cumulative_used)
                      : "—"}
                  </td>
                  <td className="px-3 py-2">
                    {b.verified_at ? (
                      <span className="text-emerald-700 text-xs">
                        ✓ {b.verification_method ?? ""}
                      </span>
                    ) : (
                      <button
                        onClick={() => verify(b)}
                        disabled={verifyMut.isPending}
                        className="px-2 py-0.5 rounded bg-amber-600 text-white text-xs disabled:opacity-40"
                      >
                        Verify
                      </button>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {b.age_eligible ? "" : "✗ age"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <AddBeneficiaryModal
          patientUid={submittedUid}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ["pmjay", "beneficiaries"] });
          }}
        />
      )}
    </div>
  );
}

function AddBeneficiaryModal({
  patientUid,
  onClose,
  onSaved,
}: {
  patientUid: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    scheme_code: "AB-PMJAY",
    beneficiary_id: "",
    family_id: "",
    card_number: "",
    policyholder_name: "",
    state_code: "",
    policy_year: "",
  });
  const mut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/pmjay/beneficiaries", {
        method: "POST",
        body: {
          patient_uid: patientUid,
          ...Object.fromEntries(Object.entries(form).filter(([, v]) => v)),
        },
      }),
    onSuccess: onSaved,
  });
  const errMsg = mut.error instanceof Error ? mut.error.message : null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-card rounded-lg shadow-lg w-full max-w-md">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Link scheme beneficiary</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Scheme
            </label>
            <select
              value={form.scheme_code}
              onChange={(e) =>
                setForm({ ...form, scheme_code: e.target.value })
              }
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            >
              <option value="AB-PMJAY">AB-PMJAY (central)</option>
              <option value="CGHS">CGHS</option>
              <option value="ESIC">ESIC</option>
              <option value="MJPJAY">MJPJAY (Maharashtra)</option>
              <option value="BSKY">BSKY (Odisha)</option>
              <option value="RGJAY">RGJAY</option>
            </select>
          </div>
          {[
            { k: "beneficiary_id", l: "Beneficiary / PMJAY ID *" },
            { k: "family_id", l: "Family ID" },
            { k: "card_number", l: "Card number" },
            { k: "policyholder_name", l: "Policy holder (household head)" },
            { k: "state_code", l: "State code (e.g. KA)" },
            { k: "policy_year", l: "Policy year (e.g. 2026-27)" },
          ].map(({ k, l }) => (
            <div key={k}>
              <label className="text-xs text-muted-foreground block mb-1">
                {l}
              </label>
              <input
                value={form[k as keyof typeof form]}
                onChange={(e) => setForm({ ...form, [k]: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              />
            </div>
          ))}
          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !form.beneficiary_id}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {mut.isPending ? "Linking…" : "Link"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PackagesTab() {
  const [q, setQ] = useState("");
  const [scheme, setScheme] = useState("");

  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<PmjayPackage[]>({
    queryKey: ["pmjay", "packages", { q, scheme }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "300" });
      if (q) params.set("q", q);
      if (scheme) params.set("scheme_code", scheme);
      const r = await fetchAdminAPI<unknown>(
        `/pmjay/packages?${params.toString()}`,
      );
      return unwrapList<PmjayPackage>(r);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Scheme
          </label>
          <select
            value={scheme}
            onChange={(e) => setScheme(e.target.value)}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          >
            <option value="">All</option>
            <option value="AB-PMJAY">AB-PMJAY</option>
            <option value="CGHS">CGHS</option>
            <option value="ESIC">ESIC</option>
            <option value="MJPJAY">MJPJAY</option>
            <option value="BSKY">BSKY</option>
          </select>
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">
            Search
          </label>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="cataract / CABG / GS-15-…"
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
          title="No packages"
          description="No HBP packages match this filter."
        />
      ) : (
        <div className="bg-card rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Scheme</th>
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Procedure</th>
                <th className="px-3 py-2">Specialty</th>
                <th className="px-3 py-2 text-right">Rate</th>
                <th className="px-3 py-2">LOS</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  className="border-b last:border-0 hover:bg-muted/40"
                >
                  <td className="px-3 py-2 font-mono text-xs">
                    {p.scheme_code}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {p.package_code}
                  </td>
                  <td className="px-3 py-2">{p.procedure_name}</td>
                  <td className="px-3 py-2 text-xs">
                    {p.specialty_group ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-right">
                    {fmtINR(p.package_rate)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {p.los_days != null ? `${p.los_days}d` : "—"}
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
