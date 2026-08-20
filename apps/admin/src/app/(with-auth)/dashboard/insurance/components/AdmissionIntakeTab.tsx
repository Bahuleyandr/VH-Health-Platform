"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { CodeMultiSearchField } from "@/components/terminology/CodeSearchField";
import { fetchAdminAPI } from "@/lib/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useState } from "react";

import {
  fmtDate,
  fmtINR,
  STATUS_COLOURS,
  type InsurancePolicy,
  type Preauth,
} from "./types";

interface AdmissionRow {
  id: number;
  patient_uid: string | null;
  patient_name: string | null;
  patient_phone: string | null;
  ward: string | null;
  bed_number: string | null;
  department: string | null;
  admission_type: string | null;
  admitting_diagnosis: string | null;
  chief_complaint: string | null;
  admitted_at: string | null;
  expected_los_days: number | string | null;
  status: string | null;
}

interface AdmissionDetail extends AdmissionRow {
  room_category?: string | null;
  admitting_doctor_name?: string | null;
  attending_doctor_name?: string | null;
}

interface InsurancePackage {
  id: number;
  package_code: string;
  display_name: string;
  base_specialty: string | null;
  duration_days: number | null;
  fixed_price_minor: number | string | null;
  currency: string | null;
}

interface PackageEstimate {
  package: {
    id: number;
    package_code: string;
    display_name: string;
  };
  line_items: Array<{
    kind: string;
    label: string;
    amount_minor: number | null;
    review_required: boolean;
    note?: string;
  }>;
  estimated_total_minor: number;
  estimated_total_is_lower_bound: boolean;
  review_required: boolean;
  review_flags: string[];
  currency: string;
}

interface IntakeForm {
  insurer_name: string;
  tpa_name: string;
  policy_number: string;
  member_id: string;
  policyholder_name: string;
  relation_to_patient: string;
  policy_type: string;
  corporate_employer: string;
  sum_insured: string;
  valid_from: string;
  valid_to: string;
  package_id: string;
  room_category: string;
  expected_los_days: string;
  expected_cost: string;
  request_type: "planned" | "emergency";
  primary_diagnosis: string;
  icd10_codes: string[];
  proposed_procedure: string;
  notes: string;
  submitNow: boolean;
}

type IntakeResult = {
  policy: InsurancePolicy;
  preauth: Preauth;
  submitted: boolean;
};

const EMPTY_FORM: IntakeForm = {
  insurer_name: "",
  tpa_name: "",
  policy_number: "",
  member_id: "",
  policyholder_name: "",
  relation_to_patient: "self",
  policy_type: "cashless",
  corporate_employer: "",
  sum_insured: "",
  valid_from: "",
  valid_to: "",
  package_id: "",
  room_category: "",
  expected_los_days: "",
  expected_cost: "",
  request_type: "planned",
  primary_diagnosis: "",
  icd10_codes: [],
  proposed_procedure: "",
  notes: "",
  submitNow: true,
};
const EMPTY_PACKAGES: InsurancePackage[] = [];

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function unwrapAdmission(r: unknown): AdmissionDetail {
  const data = unwrap<{ admission?: AdmissionDetail } | AdmissionDetail>(r);
  return ((data as { admission?: AdmissionDetail }).admission ??
    data) as AdmissionDetail;
}

function asNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toINRFromMinor(minor: number | string | null | undefined): string {
  const n = Number(minor ?? 0);
  if (!Number.isFinite(n)) return "0";
  return String(Math.round(n / 100));
}

function fmtMinorINR(minor: number | string | null | undefined): string {
  const n = Number(minor ?? 0);
  return fmtINR(Number.isFinite(n) ? n / 100 : 0);
}

function isoDate(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  return String(s).slice(0, 10);
}

function admissionTitle(admission: AdmissionRow): string {
  const patient =
    admission.patient_name ||
    admission.patient_uid?.slice(0, 8) ||
    "Unknown patient";
  return `#${admission.id} ${patient}`;
}

export function AdmissionIntakeTab() {
  const qc = useQueryClient();
  const [admissionIdInput, setAdmissionIdInput] = useState("");
  const [selectedAdmissionId, setSelectedAdmissionId] = useState<number | null>(
    null,
  );
  const [form, setForm] = useState<IntakeForm>(EMPTY_FORM);
  const [estimate, setEstimate] = useState<PackageEstimate | null>(null);
  const [result, setResult] = useState<IntakeResult | null>(null);

  const admissionsQuery = useQuery<AdmissionRow[]>({
    queryKey: ["insurance", "admission-intake", "active-admissions"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/emr/admissions?limit=50");
      const rows = unwrap<AdmissionRow[]>(r);
      return Array.isArray(rows) ? rows : [];
    },
  });

  const packagesQuery = useQuery<InsurancePackage[]>({
    queryKey: ["insurance", "packages", "active"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/insurance/packages?status=active",
      );
      const rows = unwrap<InsurancePackage[]>(r);
      return Array.isArray(rows) ? rows : [];
    },
  });

  const admissionQuery = useQuery<AdmissionDetail>({
    queryKey: [
      "insurance",
      "admission-intake",
      "admission",
      selectedAdmissionId,
    ],
    queryFn: async () =>
      unwrapAdmission(
        await fetchAdminAPI<unknown>(`/emr/admission/${selectedAdmissionId}`),
      ),
    enabled: selectedAdmissionId != null,
  });

  const admission = admissionQuery.data ?? null;
  const packageOptions = packagesQuery.data ?? EMPTY_PACKAGES;
  const selectedPackage = useMemo(
    () => packageOptions.find((p) => String(p.id) === form.package_id) ?? null,
    [form.package_id, packageOptions],
  );

  useEffect(() => {
    if (!admission) return;
    setForm((prev) => ({
      ...prev,
      primary_diagnosis:
        prev.primary_diagnosis ||
        admission.admitting_diagnosis ||
        admission.chief_complaint ||
        "",
      expected_los_days:
        prev.expected_los_days || String(admission.expected_los_days ?? ""),
      room_category: prev.room_category || admission.room_category || "",
    }));
  }, [admission]);

  const estimateMut = useMutation({
    mutationFn: async () => {
      if (!form.package_id)
        throw new Error("Choose a package before estimating");
      const r = await fetchAdminAPI<unknown>("/insurance/packages/estimate", {
        method: "POST",
        body: {
          package_id: Number(form.package_id),
          room_category:
            form.room_category || admission?.room_category || undefined,
          los_days: asNumber(form.expected_los_days),
        },
      });
      return unwrap<PackageEstimate>(r);
    },
    onSuccess: (nextEstimate) => {
      setEstimate(nextEstimate);
      setForm((prev) => ({
        ...prev,
        expected_cost: toINRFromMinor(nextEstimate.estimated_total_minor),
        proposed_procedure:
          prev.proposed_procedure || nextEstimate.package.display_name,
      }));
    },
  });

  const intakeMut = useMutation({
    mutationFn: async (): Promise<IntakeResult> => {
      if (!admission) throw new Error("Load an admission first");
      if (!admission.patient_uid)
        throw new Error("Admission is missing patient_uid");
      if (!form.policy_number.trim())
        throw new Error("Policy number is required");
      if (!form.primary_diagnosis.trim())
        throw new Error("Primary diagnosis is required");
      const expectedCost = asNumber(form.expected_cost);
      if (!expectedCost || expectedCost <= 0)
        throw new Error("Expected cost must be > 0");

      const policy = await fetchAdminAPI<InsurancePolicy>(
        "/insurance/policies",
        {
          method: "POST",
          body: {
            patient_uid: admission.patient_uid,
            insurer_name: form.insurer_name.trim() || undefined,
            tpa_name: form.tpa_name.trim() || undefined,
            policy_number: form.policy_number.trim(),
            member_id: form.member_id.trim() || undefined,
            policyholder_name: form.policyholder_name.trim() || undefined,
            relation_to_patient: form.relation_to_patient.trim() || undefined,
            policy_type: form.policy_type.trim() || undefined,
            corporate_employer: form.corporate_employer.trim() || undefined,
            sum_insured: asNumber(form.sum_insured),
            valid_from: form.valid_from || undefined,
            valid_to: form.valid_to || undefined,
            notes: form.notes.trim() || undefined,
          },
        },
      );

      const preauth = await fetchAdminAPI<Preauth>("/insurance/preauth", {
        method: "POST",
        body: {
          policy_id: policy.id,
          patient_uid: admission.patient_uid,
          admission_id: admission.id,
          request_type: form.request_type,
          primary_diagnosis: form.primary_diagnosis.trim(),
          icd10_codes:
            form.icd10_codes.length > 0 ? form.icd10_codes : undefined,
          proposed_procedure: form.proposed_procedure.trim() || undefined,
          expected_admission_date: isoDate(admission.admitted_at),
          expected_los_days: asNumber(form.expected_los_days),
          expected_cost: expectedCost,
          cost_breakdown: estimate
            ? {
                source: "insurance_package_estimate",
                package_id: estimate.package.id,
                package_code: estimate.package.package_code,
                estimated_total_minor: estimate.estimated_total_minor,
                estimated_total_is_lower_bound:
                  estimate.estimated_total_is_lower_bound,
                review_required: estimate.review_required,
                review_flags: estimate.review_flags,
                line_items: estimate.line_items,
              }
            : {
                source: "manual_admission_intake",
                package_id: selectedPackage?.id ?? null,
                package_code: selectedPackage?.package_code ?? null,
              },
          notes: form.notes.trim() || undefined,
        },
      });

      const finalPreauth = form.submitNow
        ? await fetchAdminAPI<Preauth>(
            `/insurance/preauth/${preauth.id}/submit`,
            {
              method: "POST",
              body: { submission_channel: "portal" },
            },
          )
        : preauth;

      return { policy, preauth: finalPreauth, submitted: form.submitNow };
    },
    onSuccess: (nextResult) => {
      setResult(nextResult);
      qc.invalidateQueries({ queryKey: ["insurance", "preauth"] });
      qc.invalidateQueries({ queryKey: ["insurance", "policies"] });
    },
  });

  const error =
    admissionQuery.error ??
    admissionsQuery.error ??
    packagesQuery.error ??
    estimateMut.error ??
    intakeMut.error;
  const errorMessage = error instanceof Error ? error.message : null;
  const busy =
    admissionQuery.isFetching || estimateMut.isPending || intakeMut.isPending;

  function update<K extends keyof IntakeForm>(key: K, value: IntakeForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (
      key === "package_id" ||
      key === "room_category" ||
      key === "expected_los_days"
    ) {
      setEstimate(null);
    }
  }

  function loadAdmission(id: number) {
    setSelectedAdmissionId(id);
    setAdmissionIdInput(String(id));
    setResult(null);
    setEstimate(null);
  }

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const id = Number(admissionIdInput);
          if (Number.isInteger(id) && id > 0) loadAdmission(id);
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="min-w-[220px] flex-1">
          <label
            htmlFor="insurance-admission-id"
            className="mb-1 block text-xs text-muted-foreground"
          >
            Admission ID
          </label>
          <input
            id="insurance-admission-id"
            value={admissionIdInput}
            onChange={(e) => setAdmissionIdInput(e.target.value)}
            placeholder="e.g. 1042"
            className="w-full rounded-lg border border-border px-3 py-2 text-sm font-mono"
            inputMode="numeric"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !admissionIdInput.trim()}
          className="rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-40"
        >
          Load admission
        </button>
      </form>

      {errorMessage && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(280px,380px)_1fr]">
        <section className="rounded-lg border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-base font-semibold">Active admissions</h2>
          </div>
          <div className="max-h-[560px] overflow-auto">
            {admissionsQuery.isLoading ? (
              <div className="p-4">
                <LoadingSpinner />
              </div>
            ) : (admissionsQuery.data ?? []).length === 0 ? (
              <div className="p-4">
                <EmptyState
                  title="No active admissions"
                  description="Load by admission ID."
                />
              </div>
            ) : (
              <table className="min-w-full text-sm">
                <thead className="sticky top-0 border-b bg-card text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Admission</th>
                    <th className="px-3 py-2">Bed</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(admissionsQuery.data ?? []).map((row) => (
                    <tr
                      key={row.id}
                      className="border-b last:border-0 hover:bg-muted/40"
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{admissionTitle(row)}</div>
                        <div className="text-xs text-muted-foreground">
                          {row.admitting_diagnosis ||
                            row.chief_complaint ||
                            "No diagnosis"}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        <div>{row.ward ?? row.department ?? "—"}</div>
                        <div className="text-muted-foreground">
                          {row.bed_number ?? "No bed"}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => loadAdmission(row.id)}
                          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                        >
                          Use
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <section className="rounded-lg border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h2 className="text-base font-semibold">Admission TPA intake</h2>
          </div>
          {!admission ? (
            <div className="p-6">
              <EmptyState
                title="Choose an admission"
                description="Select an active admission or load one by ID."
              />
            </div>
          ) : (
            <div className="space-y-5 p-4">
              <div className="grid gap-3 rounded-lg border bg-muted/20 p-3 text-sm md:grid-cols-4">
                <div>
                  <div className="text-xs text-muted-foreground">Admission</div>
                  <div className="font-mono">#{admission.id}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Patient</div>
                  <div>
                    {admission.patient_name ??
                      admission.patient_uid?.slice(0, 8) ??
                      "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">
                    Ward / bed
                  </div>
                  <div>
                    {[admission.ward, admission.bed_number]
                      .filter(Boolean)
                      .join(" / ") || "—"}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Admitted</div>
                  <div>{fmtDate(admission.admitted_at)}</div>
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Field
                  label="Insurer"
                  value={form.insurer_name}
                  onChange={(v) => update("insurer_name", v)}
                  placeholder="Star Health"
                />
                <Field
                  label="TPA"
                  value={form.tpa_name}
                  onChange={(v) => update("tpa_name", v)}
                  placeholder="Medi Assist"
                />
                <Field
                  label="Policy number"
                  value={form.policy_number}
                  onChange={(v) => update("policy_number", v)}
                  required
                />
                <Field
                  label="Member ID"
                  value={form.member_id}
                  onChange={(v) => update("member_id", v)}
                />
                <Field
                  label="Policyholder"
                  value={form.policyholder_name}
                  onChange={(v) => update("policyholder_name", v)}
                  placeholder={admission.patient_name ?? ""}
                />
                <Field
                  label="Relation"
                  value={form.relation_to_patient}
                  onChange={(v) => update("relation_to_patient", v)}
                />
                <Field
                  label="Policy type"
                  value={form.policy_type}
                  onChange={(v) => update("policy_type", v)}
                />
                <Field
                  label="Corporate employer"
                  value={form.corporate_employer}
                  onChange={(v) => update("corporate_employer", v)}
                />
                <Field
                  label="Sum insured"
                  value={form.sum_insured}
                  onChange={(v) => update("sum_insured", v)}
                  inputMode="decimal"
                />
                <div className="grid grid-cols-2 gap-3">
                  <Field
                    label="Valid from"
                    type="date"
                    value={form.valid_from}
                    onChange={(v) => update("valid_from", v)}
                  />
                  <Field
                    label="Valid to"
                    type="date"
                    value={form.valid_to}
                    onChange={(v) => update("valid_to", v)}
                  />
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-3">
                <div>
                  <label
                    htmlFor="insurance-package"
                    className="mb-1 block text-xs text-muted-foreground"
                  >
                    Package
                  </label>
                  <select
                    id="insurance-package"
                    value={form.package_id}
                    onChange={(e) => update("package_id", e.target.value)}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <option value="">Manual estimate</option>
                    {packageOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.package_code} — {p.display_name}
                      </option>
                    ))}
                  </select>
                </div>
                <Field
                  label="Room category"
                  value={form.room_category}
                  onChange={(v) => update("room_category", v)}
                  placeholder="general / private"
                />
                <Field
                  label="LOS days"
                  value={form.expected_los_days}
                  onChange={(v) => update("expected_los_days", v)}
                  inputMode="numeric"
                />
                <div className="md:col-span-2">
                  <Field
                    label="Expected cost"
                    value={form.expected_cost}
                    onChange={(v) => update("expected_cost", v)}
                    inputMode="decimal"
                    required
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    disabled={!form.package_id || estimateMut.isPending}
                    onClick={() => estimateMut.mutate()}
                    className="w-full rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-40"
                  >
                    Estimate package
                  </button>
                </div>
              </div>

              {estimate && (
                <div className="rounded-lg border border-blue-200 bg-blue-50/60 p-3 text-sm">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="font-medium">
                      {estimate.package.package_code} estimate:{" "}
                      {fmtMinorINR(estimate.estimated_total_minor)}
                      {estimate.estimated_total_is_lower_bound
                        ? " lower bound"
                        : ""}
                    </div>
                    {estimate.review_required && (
                      <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                        finance review
                      </span>
                    )}
                  </div>
                  <ul className="space-y-1">
                    {estimate.line_items.map((line) => (
                      <li
                        key={`${line.kind}-${line.label}`}
                        className="flex justify-between gap-3"
                      >
                        <span>{line.label}</span>
                        <span className="font-mono">
                          {line.amount_minor == null
                            ? "review"
                            : fmtMinorINR(line.amount_minor)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid gap-3 md:grid-cols-2">
                <div>
                  <label
                    htmlFor="insurance-request-type"
                    className="mb-1 block text-xs text-muted-foreground"
                  >
                    Request type
                  </label>
                  <select
                    id="insurance-request-type"
                    value={form.request_type}
                    onChange={(e) =>
                      update(
                        "request_type",
                        e.target.value as IntakeForm["request_type"],
                      )
                    }
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  >
                    <option value="planned">Planned</option>
                    <option value="emergency">Emergency</option>
                  </select>
                </div>
                <Field
                  label="Primary diagnosis"
                  value={form.primary_diagnosis}
                  onChange={(v) => update("primary_diagnosis", v)}
                  required
                />
                <CodeMultiSearchField
                  label="ICD-10 codes (optional)"
                  values={form.icd10_codes}
                  onChange={(codes) => update("icd10_codes", codes)}
                  labelClassName="mb-1 block text-xs text-muted-foreground"
                  inputClassName="w-full rounded-lg border border-border px-3 py-2 text-sm"
                />
                <Field
                  label="Proposed procedure"
                  value={form.proposed_procedure}
                  onChange={(v) => update("proposed_procedure", v)}
                />
                <label className="flex items-end gap-2 rounded-lg border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.submitNow}
                    onChange={(e) => update("submitNow", e.target.checked)}
                    className="mb-1"
                  />
                  Submit to TPA with admission note, advice letter, and record
                  bundle
                </label>
                <div className="md:col-span-2">
                  <label
                    htmlFor="insurance-notes"
                    className="mb-1 block text-xs text-muted-foreground"
                  >
                    Notes
                  </label>
                  <textarea
                    id="insurance-notes"
                    value={form.notes}
                    onChange={(e) => update("notes", e.target.value)}
                    rows={3}
                    className="w-full rounded-lg border border-border px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={intakeMut.isPending}
                  onClick={() => intakeMut.mutate()}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                >
                  {form.submitNow
                    ? "Create and submit pre-auth"
                    : "Create draft pre-auth"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setForm(EMPTY_FORM);
                    setEstimate(null);
                    setResult(null);
                  }}
                  className="rounded-md border px-3 py-2 text-sm hover:bg-muted"
                >
                  Reset form
                </button>
              </div>

              {result && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
                  <div className="font-medium">
                    {result.submitted ? "Submitted" : "Draft created"}:{" "}
                    {result.preauth.preauth_number}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-3 text-xs">
                    <span>Policy {result.policy.policy_number}</span>
                    <span
                      className={`rounded px-2 py-0.5 ${STATUS_COLOURS[result.preauth.status] ?? "bg-slate-100"}`}
                    >
                      {result.preauth.status}
                    </span>
                    <span>{fmtINR(result.preauth.expected_cost)}</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  required = false,
  type = "text",
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: string;
  inputMode?: "numeric" | "decimal";
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs text-muted-foreground">
        {label}
        {required ? " *" : ""}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        inputMode={inputMode}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm"
      />
    </div>
  );
}
