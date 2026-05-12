// src/app/(with-auth)/dashboard/pcpndt/page.tsx
//
// Sprint 18 — PCPNDT compliance: USG register (Form F), machine
// roster, sonologist roster, monthly submission rollup.

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

type Tab = "register" | "machines" | "sonologists" | "submissions";

interface FormFRow {
  id: number;
  serial_no: number;
  test_date: string;
  patient_name: string;
  patient_age: number;
  gravida: number;
  parity: number;
  indication_category: string | null;
  status: string;
  submitted_at: string | null;
  machine_code: string | null;
  sonologist_name: string | null;
}

interface Machine {
  id: number;
  machine_code: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  pcpndt_registration_no: string;
  registered_at: string | null;
  registration_valid_to: string | null;
  location: string | null;
  status: string;
}

interface Sonologist {
  id: number;
  staff_uid: string | null;
  name: string;
  qualification: string | null;
  medical_council_reg: string | null;
  pcpndt_training_cert_no: string | null;
  pcpndt_training_date: string | null;
  undertaking_signed_at: string | null;
  active: boolean;
}

interface Submission {
  id: number;
  period_year: number;
  period_month: number;
  generated_at: string;
  total_forms: number;
  submitted_to_authority_at: string | null;
  authority_reference: string | null;
}

const STATUS_COLOURS: Record<string, string> = {
  draft: "bg-slate-100 text-slate-700",
  completed: "bg-blue-100 text-blue-800",
  submitted_to_authority: "bg-emerald-100 text-emerald-800",
  voided: "bg-rose-100 text-rose-800",
};

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleDateString();
}

export default function PcpndtPage() {
  const [tab, setTab] = useState<Tab>("register");
  return (
    <div className="p-6">
      <h1 className="text-3xl font-bold text-foreground mb-1">
        PCPNDT Compliance
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        Form F register, USG machine + sonologist rosters, and monthly
        submission to the District Appropriate Authority. Required by the
        Pre-Conception and Pre-Natal Diagnostic Techniques Act.
      </p>
      <div className="flex gap-1 bg-muted rounded-lg p-1 mb-6 w-fit overflow-x-auto">
        {(
          [
            { key: "register", label: "📋 USG register" },
            { key: "machines", label: "🩻 Machines" },
            { key: "sonologists", label: "👨‍⚕️ Sonologists" },
            { key: "submissions", label: "📨 Monthly submissions" },
          ] as { key: Tab; label: string }[]
        ).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors whitespace-nowrap ${
              tab === key
                ? "bg-white text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "register" && <RegisterTab />}
      {tab === "machines" && <MachinesTab />}
      {tab === "sonologists" && <SonologistsTab />}
      {tab === "submissions" && <SubmissionsTab />}
    </div>
  );
}

// ── Register tab ─────────────────────────────────────────────────────

function RegisterTab() {
  const qc = useQueryClient();
  const today = new Date().toISOString().split("T")[0]!;
  const monthAgo = new Date(Date.now() - 30 * 86400 * 1000).toISOString().split("T")[0]!;
  const [filters, setFilters] = useState({ from: monthAgo, to: today, status: "" });
  const [showCreate, setShowCreate] = useState(false);

  const { data: rows = [], isLoading, error } = useQuery<FormFRow[]>({
    queryKey: ["pcpndt", "forms", filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.from) params.set("from", filters.from);
      if (filters.to) params.set("to", filters.to);
      if (filters.status) params.set("status", filters.status);
      params.set("limit", "200");
      const r = await fetchAdminAPI<unknown>(
        `/pcpndt/form-f?${params.toString()}`,
      );
      return unwrapList<FormFRow>(r);
    },
  });

  const errMsg = error?.toString();
  const pendingSubmission = rows.filter((r) => r.status === "completed").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">In window</p>
          <p className="text-xl font-semibold mt-1">{rows.length}</p>
        </div>
        <div className={`bg-white rounded-lg border shadow-sm p-3 ${pendingSubmission > 0 ? "border-amber-300" : ""}`}>
          <p className="text-xs text-muted-foreground">Pending submission</p>
          <p className={`text-xl font-semibold mt-1 ${pendingSubmission > 0 ? "text-amber-700" : ""}`}>
            {pendingSubmission}
          </p>
        </div>
        <div className="bg-white rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Submitted</p>
          <p className="text-xl font-semibold mt-1">
            {rows.filter((r) => r.status === "submitted_to_authority").length}
          </p>
        </div>
        <div className="bg-white rounded-lg border shadow-sm p-3">
          <p className="text-xs text-muted-foreground">Voided</p>
          <p className="text-xl font-semibold mt-1">
            {rows.filter((r) => r.status === "voided").length}
          </p>
        </div>
      </div>

      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">From</label>
          <input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">To</label>
          <input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            className="border border-border rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Status</label>
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
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
          + New Form F
        </button>
        <div className="flex-1" />
        <button
          onClick={() => qc.invalidateQueries({ queryKey: ["pcpndt", "forms"] })}
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
        <EmptyState title="No entries" description="No Form F entries in this window." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Serial #</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">G/P</th>
                <th className="px-3 py-2">Indication</th>
                <th className="px-3 py-2">Machine</th>
                <th className="px-3 py-2">Sonologist</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 font-mono text-xs">#{r.serial_no}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(r.test_date)}</td>
                  <td className="px-3 py-2">
                    <div>{r.patient_name}</div>
                    <div className="text-xs text-muted-foreground">{r.patient_age} y</div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">G{r.gravida}P{r.parity}</td>
                  <td className="px-3 py-2 text-xs">
                    {r.indication_category?.replace(/_/g, " ") ?? "—"}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{r.machine_code ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">{r.sonologist_name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_COLOURS[r.status] ?? ""
                      }`}
                    >
                      {r.status.replace(/_/g, " ")}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <NewFormFModal
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ["pcpndt", "forms"] });
          }}
        />
      )}
    </div>
  );
}

function NewFormFModal({
  onClose, onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [form, setForm] = useState({
    test_date: new Date().toISOString().split("T")[0]!,
    patient_uid: "",
    patient_name: "",
    patient_age: "",
    husband_or_father_name: "",
    full_address: "",
    contact_number: "",
    gravida: "1",
    parity: "0",
    abortions: "0",
    living_children: "0",
    living_children_sex: "",
    lmp_date: "",
    gestational_age_weeks: "",
    indication: "",
    indication_category: "to_diagnose_intrauterine_pregnancy",
    referred_by_doctor_name: "",
    referred_by_reg_no: "",
    machine_id: 0,
    sonologist_id: 0,
    procedure_findings: "",
  });
  const [confirmed, setConfirmed] = useState(false);

  const { data: machines = [] } = useQuery<Machine[]>({
    queryKey: ["pcpndt", "machines"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/pcpndt/machines");
      return unwrapList<Machine>(r);
    },
    staleTime: 5 * 60 * 1000,
  });
  const { data: sonologists = [] } = useQuery<Sonologist[]>({
    queryKey: ["pcpndt", "sonologists"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/pcpndt/sonologists");
      return unwrapList<Sonologist>(r);
    },
    staleTime: 5 * 60 * 1000,
  });

  const mut = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        test_date: form.test_date,
        patient_uid: form.patient_uid || undefined,
        patient_name: form.patient_name,
        patient_age: Number(form.patient_age),
        husband_or_father_name: form.husband_or_father_name,
        full_address: form.full_address,
        contact_number: form.contact_number || undefined,
        gravida: Number(form.gravida),
        parity: Number(form.parity),
        abortions: Number(form.abortions),
        living_children: Number(form.living_children),
        living_children_sex: form.living_children_sex || undefined,
        lmp_date: form.lmp_date || undefined,
        gestational_age_weeks: form.gestational_age_weeks
          ? Number(form.gestational_age_weeks)
          : undefined,
        indication: form.indication,
        indication_category: form.indication_category,
        referred_by_doctor_name: form.referred_by_doctor_name || undefined,
        referred_by_reg_no: form.referred_by_reg_no || undefined,
        machine_id: form.machine_id,
        sonologist_id: form.sonologist_id,
        procedure_findings: form.procedure_findings || undefined,
        sex_determination_disclosed: false,
        consent_taken: true,
      };
      return fetchAdminAPI("/pcpndt/form-f", {
        method: "POST",
        body: body,
      });
    },
    onSuccess: onCreated,
  });

  const errMsg = mut.error instanceof Error ? mut.error.message : null;

  const canSubmit =
    form.patient_name &&
    form.patient_age &&
    form.husband_or_father_name &&
    form.full_address &&
    form.indication &&
    form.machine_id > 0 &&
    form.sonologist_id > 0 &&
    confirmed;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-3xl mb-8">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">New Form F entry</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-4 space-y-3 max-h-[70vh] overflow-y-auto">
          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Identity</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Test date" type="date" value={form.test_date}
                onChange={(v) => setForm({ ...form, test_date: v })} />
              <Field label="Patient UID (optional)" mono value={form.patient_uid}
                onChange={(v) => setForm({ ...form, patient_uid: v })} />
              <Field label="Patient name *" value={form.patient_name}
                onChange={(v) => setForm({ ...form, patient_name: v })} />
              <Field label="Age (yr) *" type="number" value={form.patient_age}
                onChange={(v) => setForm({ ...form, patient_age: v })} />
              <Field label="Husband / father name *" value={form.husband_or_father_name}
                onChange={(v) => setForm({ ...form, husband_or_father_name: v })} />
              <Field label="Contact number" value={form.contact_number}
                onChange={(v) => setForm({ ...form, contact_number: v })} />
            </div>
            <Field label="Full address *" value={form.full_address}
              onChange={(v) => setForm({ ...form, full_address: v })} />
          </section>

          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Pregnancy</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="Gravida" type="number" value={form.gravida}
                onChange={(v) => setForm({ ...form, gravida: v })} />
              <Field label="Parity" type="number" value={form.parity}
                onChange={(v) => setForm({ ...form, parity: v })} />
              <Field label="Abortions" type="number" value={form.abortions}
                onChange={(v) => setForm({ ...form, abortions: v })} />
              <Field label="Living children" type="number" value={form.living_children}
                onChange={(v) => setForm({ ...form, living_children: v })} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Living children sex" value={form.living_children_sex}
                onChange={(v) => setForm({ ...form, living_children_sex: v })}
                hint="e.g. M / M / F" />
              <Field label="LMP date" type="date" value={form.lmp_date}
                onChange={(v) => setForm({ ...form, lmp_date: v })} />
              <Field label="Gestational age (weeks)" type="number" value={form.gestational_age_weeks}
                onChange={(v) => setForm({ ...form, gestational_age_weeks: v })} />
            </div>
          </section>

          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Indication</p>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">
                Category *
              </label>
              <select
                value={form.indication_category}
                onChange={(e) => setForm({ ...form, indication_category: e.target.value })}
                className="w-full border border-border rounded-lg px-3 py-2 text-sm"
              >
                {[
                  ["to_diagnose_intrauterine_pregnancy", "To diagnose intrauterine pregnancy"],
                  ["genetic_testing_with_consent", "Genetic testing (with consent)"],
                  ["detection_of_anomalies", "Detection of anomalies"],
                  ["multiple_pregnancy", "Multiple pregnancy"],
                  ["placental_localisation", "Placental localisation"],
                  ["fetal_well_being", "Fetal well-being"],
                  ["cervical_incompetence", "Cervical incompetence"],
                  ["placenta_praevia", "Placenta praevia"],
                  ["other", "Other"],
                ].map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </div>
            <Field
              label="Indication detail (free text) *"
              value={form.indication}
              onChange={(v) => setForm({ ...form, indication: v })}
              multiline
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Referred by (doctor)" value={form.referred_by_doctor_name}
                onChange={(v) => setForm({ ...form, referred_by_doctor_name: v })} />
              <Field label="Referrer reg #" value={form.referred_by_reg_no}
                onChange={(v) => setForm({ ...form, referred_by_reg_no: v })} />
            </div>
          </section>

          <section>
            <p className="text-xs font-semibold text-muted-foreground uppercase mb-2">Procedure</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Machine *</label>
                <select
                  value={form.machine_id || ""}
                  onChange={(e) => setForm({ ...form, machine_id: Number(e.target.value) })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Select machine…</option>
                  {machines.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.machine_code} · {m.manufacturer} {m.model} · Reg {m.pcpndt_registration_no}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Sonologist *</label>
                <select
                  value={form.sonologist_id || ""}
                  onChange={(e) => setForm({ ...form, sonologist_id: Number(e.target.value) })}
                  className="w-full border border-border rounded-lg px-3 py-2 text-sm"
                >
                  <option value="">Select sonologist…</option>
                  {sonologists.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.medical_council_reg ?? "(no reg)"}
                      {s.undertaking_signed_at ? "" : " ⚠ no undertaking"}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <Field
              label="Findings"
              value={form.procedure_findings}
              onChange={(v) => setForm({ ...form, procedure_findings: v })}
              multiline
            />
          </section>

          <div className="rounded-lg border-2 border-rose-300 bg-rose-50 p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1"
              />
              <div>
                <strong>Sonologist declaration:</strong>
                <p className="text-xs mt-1">
                  I declare that the sex of the foetus has NOT been determined and
                  has NOT been disclosed to the patient or any other person. The
                  test was performed for the indication recorded above. Patient
                  consent was obtained before the test.
                </p>
              </div>
            </label>
          </div>

          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md border text-sm hover:bg-muted">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !canSubmit}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {mut.isPending ? "Recording…" : "Record Form F"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text", hint, multiline, mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
  multiline?: boolean;
  mono?: boolean;
}) {
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">{label}</label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className={`w-full border border-border rounded-lg px-3 py-2 text-sm ${mono ? "font-mono" : ""}`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full border border-border rounded-lg px-3 py-2 text-sm ${mono ? "font-mono" : ""}`}
        />
      )}
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </div>
  );
}

// ── Machines tab ─────────────────────────────────────────────────────

function MachinesTab() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const { data: rows = [], isLoading, error } = useQuery<Machine[]>({
    queryKey: ["pcpndt", "machines", "all"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/pcpndt/machines?includeInactive=true",
      );
      return unwrapList<Machine>(r);
    },
  });

  const errMsg = error?.toString();

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setShowAdd(true)}
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          + Register machine
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
        <EmptyState title="No machines" description="Register at least one PCPNDT-registered USG machine." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Code</th>
                <th className="px-3 py-2">Manufacturer / Model</th>
                <th className="px-3 py-2">Serial #</th>
                <th className="px-3 py-2">PCPNDT Reg #</th>
                <th className="px-3 py-2">Validity</th>
                <th className="px-3 py-2">Location</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => {
                const expired = m.registration_valid_to &&
                  new Date(m.registration_valid_to) < new Date();
                return (
                  <tr key={m.id} className={`border-b last:border-0 ${expired ? "bg-rose-50" : ""}`}>
                    <td className="px-3 py-2 font-mono text-xs">{m.machine_code}</td>
                    <td className="px-3 py-2">
                      <div>{m.manufacturer}</div>
                      <div className="text-xs text-muted-foreground">{m.model}</div>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{m.serial_number}</td>
                    <td className="px-3 py-2 font-mono text-xs">{m.pcpndt_registration_no}</td>
                    <td className={`px-3 py-2 text-xs ${expired ? "text-rose-700 font-semibold" : ""}`}>
                      {fmtDate(m.registration_valid_to)}
                      {expired && " (EXPIRED)"}
                    </td>
                    <td className="px-3 py-2 text-xs">{m.location ?? "—"}</td>
                    <td className="px-3 py-2 text-xs">{m.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <MachineFormModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ["pcpndt", "machines"] });
          }}
        />
      )}
    </div>
  );
}

function MachineFormModal({
  onClose, onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    machine_code: "",
    manufacturer: "",
    model: "",
    serial_number: "",
    pcpndt_registration_no: "",
    registered_at: "",
    registration_valid_to: "",
    location: "",
  });
  const mut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/pcpndt/machines", {
        method: "POST",
        body: form,
      }),
    onSuccess: onSaved,
  });
  const errMsg = mut.error instanceof Error ? mut.error.message : null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Register USG machine</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-4 space-y-3">
          {[
            ["machine_code", "Machine code (internal) *"],
            ["manufacturer", "Manufacturer *"],
            ["model", "Model *"],
            ["serial_number", "Serial number *"],
            ["pcpndt_registration_no", "PCPNDT registration # *"],
          ].map(([k, l]) => (
            <Field
              key={k}
              label={l as string}
              value={form[k as keyof typeof form]}
              onChange={(v) => setForm({ ...form, [k]: v })}
            />
          ))}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Registered on" type="date" value={form.registered_at}
              onChange={(v) => setForm({ ...form, registered_at: v })} />
            <Field label="Valid to" type="date" value={form.registration_valid_to}
              onChange={(v) => setForm({ ...form, registration_valid_to: v })} />
          </div>
          <Field label="Location" value={form.location}
            onChange={(v) => setForm({ ...form, location: v })} />
          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md border text-sm hover:bg-muted">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {mut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Sonologists tab ──────────────────────────────────────────────────

function SonologistsTab() {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const { data: rows = [], isLoading } = useQuery<Sonologist[]>({
    queryKey: ["pcpndt", "sonologists", "all"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/pcpndt/sonologists?includeInactive=true",
      );
      return unwrapList<Sonologist>(r);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          onClick={() => setShowAdd(true)}
          className="px-3 py-2 rounded-md bg-foreground text-background text-sm"
        >
          + Add sonologist
        </button>
      </div>
      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No sonologists" description="Add at least one trained sonologist with signed undertaking." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Qualification</th>
                <th className="px-3 py-2">Council reg</th>
                <th className="px-3 py-2">PCPNDT cert</th>
                <th className="px-3 py-2">Undertaking</th>
                <th className="px-3 py-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr
                  key={s.id}
                  className={`border-b last:border-0 ${
                    !s.undertaking_signed_at ? "bg-rose-50" : ""
                  }`}
                >
                  <td className="px-3 py-2">{s.name}</td>
                  <td className="px-3 py-2 text-xs">{s.qualification ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{s.medical_council_reg ?? "—"}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.pcpndt_training_cert_no ?? "—"}
                    {s.pcpndt_training_date && (
                      <div className="text-muted-foreground">{fmtDate(s.pcpndt_training_date)}</div>
                    )}
                  </td>
                  <td className={`px-3 py-2 text-xs ${!s.undertaking_signed_at ? "text-rose-700 font-semibold" : ""}`}>
                    {s.undertaking_signed_at
                      ? `Signed ${fmtDate(s.undertaking_signed_at)}`
                      : "MISSING"}
                  </td>
                  <td className="px-3 py-2 text-xs">{s.active ? "yes" : "no"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <SonologistFormModal
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            qc.invalidateQueries({ queryKey: ["pcpndt", "sonologists"] });
          }}
        />
      )}
    </div>
  );
}

function SonologistFormModal({
  onClose, onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    name: "",
    qualification: "",
    medical_council_reg: "",
    pcpndt_training_cert_no: "",
    pcpndt_training_date: "",
    undertaking_signed_at: "",
  });
  const mut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/pcpndt/sonologists", {
        method: "POST",
        body: form,
      }),
    onSuccess: onSaved,
  });
  const errMsg = mut.error instanceof Error ? mut.error.message : null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-lg">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add sonologist</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>
        <div className="p-4 space-y-3">
          {[
            ["name", "Name *"],
            ["qualification", "Qualification (e.g. MD Radiology)"],
            ["medical_council_reg", "Medical council registration # *"],
            ["pcpndt_training_cert_no", "PCPNDT training certificate #"],
          ].map(([k, l]) => (
            <Field
              key={k}
              label={l as string}
              value={form[k as keyof typeof form]}
              onChange={(v) => setForm({ ...form, [k]: v })}
            />
          ))}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Training date" type="date" value={form.pcpndt_training_date}
              onChange={(v) => setForm({ ...form, pcpndt_training_date: v })} />
            <Field label="Undertaking signed *" type="date" value={form.undertaking_signed_at}
              onChange={(v) => setForm({ ...form, undertaking_signed_at: v })} />
          </div>
          {errMsg && <p className="text-xs text-destructive">{errMsg}</p>}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md border text-sm hover:bg-muted">Cancel</button>
          <button
            onClick={() => mut.mutate()}
            disabled={mut.isPending || !form.undertaking_signed_at}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {mut.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Submissions tab ──────────────────────────────────────────────────

function SubmissionsTab() {
  const qc = useQueryClient();
  const today = new Date();
  const [period, setPeriod] = useState({
    year: today.getFullYear(),
    month: today.getMonth() + 1,
  });

  const { data: rows = [], isLoading } = useQuery<Submission[]>({
    queryKey: ["pcpndt", "submissions"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>("/pcpndt/submissions");
      return unwrapList<Submission>(r);
    },
  });

  const generateMut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/pcpndt/submissions/generate", {
        method: "POST",
        body: {
          period_year: period.year,
          period_month: period.month,
        },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pcpndt"] }),
  });

  const ackMut = useMutation({
    mutationFn: async (vars: { id: number; reference: string }) =>
      fetchAdminAPI(`/pcpndt/submissions/${vars.id}/acknowledge`, {
        method: "POST",
        body: { authority_reference: vars.reference },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pcpndt", "submissions"] }),
  });

  function ack(s: Submission) {
    const ref = window.prompt(
      `Authority acknowledgement reference for ${s.period_year}-${String(s.period_month).padStart(2, "0")}:`,
      "",
    );
    if (!ref) return;
    ackMut.mutate({ id: s.id, reference: ref });
  }

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-lg border shadow-sm p-4">
        <h3 className="text-sm font-semibold mb-2">Generate submission for period</h3>
        <div className="flex gap-3 items-end flex-wrap">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Year</label>
            <input
              type="number"
              value={period.year}
              onChange={(e) => setPeriod({ ...period, year: Number(e.target.value) })}
              className="border border-border rounded-lg px-3 py-2 text-sm font-mono w-24"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Month</label>
            <select
              value={period.month}
              onChange={(e) => setPeriod({ ...period, month: Number(e.target.value) })}
              className="border border-border rounded-lg px-3 py-2 text-sm"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
            className="px-3 py-2 rounded-md bg-foreground text-background text-sm disabled:opacity-40"
          >
            {generateMut.isPending ? "Generating…" : "Generate / refresh batch"}
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          Re-running for the same period is idempotent — picks up any
          completed-but-unsubmitted forms that have been added since.
        </p>
      </div>

      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState title="No submissions yet" description="Generate the first batch above." />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Period</th>
                <th className="px-3 py-2">Forms</th>
                <th className="px-3 py-2">Generated</th>
                <th className="px-3 py-2">Submitted to authority</th>
                <th className="px-3 py-2">Reference</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b last:border-0">
                  <td className="px-3 py-2 font-mono">
                    {s.period_year}-{String(s.period_month).padStart(2, "0")}
                  </td>
                  <td className="px-3 py-2 font-mono">{s.total_forms}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(s.generated_at)}</td>
                  <td className="px-3 py-2 text-xs">
                    {s.submitted_to_authority_at
                      ? fmtDate(s.submitted_to_authority_at)
                      : <span className="text-amber-700">pending</span>}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{s.authority_reference ?? "—"}</td>
                  <td className="px-3 py-2">
                    {!s.submitted_to_authority_at && (
                      <button
                        onClick={() => ack(s)}
                        disabled={ackMut.isPending}
                        className="px-2 py-1 rounded bg-emerald-600 text-white text-xs disabled:opacity-40"
                      >
                        Acknowledge
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
