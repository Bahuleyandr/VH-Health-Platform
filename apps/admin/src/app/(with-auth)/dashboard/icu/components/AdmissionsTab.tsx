// src/app/(with-auth)/dashboard/icu/components/AdmissionsTab.tsx

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
import { IcuAdmission, fmtDateTime, unwrap, unwrapList } from "./types";

type Props = {
  activeAdmissionId: number | null;
  onSelect: (id: number) => void;
  onJumpToFlowsheet: (id: number) => void;
};

const CODE_STATUS_LABEL: Record<string, string> = {
  full_code: "Full Code",
  dni: "DNI",
  dnr: "DNR",
  dnr_dni: "DNR / DNI",
  comfort_only: "Comfort Only",
};

const CODE_STATUS_TONE: Record<string, string> = {
  full_code: "bg-emerald-500/10 text-emerald-300",
  dni: "bg-amber-500/10 text-amber-300",
  dnr: "bg-amber-500/15 text-amber-300",
  dnr_dni: "bg-rose-500/15 text-rose-300",
  comfort_only: "bg-rose-500/20 text-rose-200",
};

export default function AdmissionsTab({
  activeAdmissionId,
  onSelect,
  onJumpToFlowsheet,
}: Props) {
  const qc = useQueryClient();
  const [showAdmit, setShowAdmit] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>("active");

  const { data: list = [], isLoading } = useQuery<IcuAdmission[]>({
    queryKey: ["icu", "admissions", statusFilter],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        `/icu/admissions?status=${statusFilter}&limit=200`,
      );
      return unwrapList<IcuAdmission>(r);
    },
    refetchInterval: 30_000,
  });

  const activeCount = list.filter((a) => a.status === "active").length;
  const dnrCount = list.filter((a) =>
    a.code_status === "dnr" || a.code_status === "dnr_dni" || a.code_status === "comfort_only",
  ).length;
  const ventedCount = list.filter((a) => a.reason_for_icu?.toLowerCase().includes("vent") ?? false).length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <KpiCard label="Active beds" value={activeCount} />
        <KpiCard label="DNR / Comfort" value={dnrCount} tone="warning" />
        <KpiCard label="Vented" value={ventedCount} />
        <KpiCard label="Total in view" value={list.length} />
      </div>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground">Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="active">Active</option>
            <option value="discharged">Discharged</option>
            <option value="transferred">Transferred</option>
            <option value="expired">Expired</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => setShowAdmit(true)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          New ICU admission
        </button>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && list.length === 0 && (
        <EmptyState title="No ICU admissions matching this filter." />
      )}

      {list.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Bed / Unit</th>
                <th className="text-left p-3">Patient</th>
                <th className="text-left p-3">Reason / Dx</th>
                <th className="text-left p-3">APACHE / SOFA</th>
                <th className="text-left p-3">Code</th>
                <th className="text-left p-3">Admitted</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr
                  key={a.id}
                  className={`border-t border-border ${
                    activeAdmissionId === a.id ? "bg-primary/10" : ""
                  }`}
                >
                  <td className="p-3 font-mono">
                    {a.unit_code}
                    {a.bed_no ? ` / ${a.bed_no}` : ""}
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {a.patient_uid.slice(0, 8)}…
                  </td>
                  <td className="p-3 max-w-[18rem] truncate" title={a.reason_for_icu ?? ""}>
                    {a.reason_for_icu || a.primary_diagnosis || "—"}
                  </td>
                  <td className="p-3 text-xs">
                    APACHE-II: {a.apache_ii_score ?? "—"}
                    <br />
                    SOFA: {a.sofa_score ?? "—"}
                  </td>
                  <td className="p-3">
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        CODE_STATUS_TONE[a.code_status] ?? ""
                      }`}
                    >
                      {CODE_STATUS_LABEL[a.code_status] ?? a.code_status}
                    </span>
                  </td>
                  <td className="p-3 text-xs">{fmtDateTime(a.admitted_at)}</td>
                  <td className="p-3 text-right">
                    <button
                      type="button"
                      onClick={() => onSelect(a.id)}
                      className="text-xs underline mr-3"
                    >
                      Select
                    </button>
                    <button
                      type="button"
                      onClick={() => onJumpToFlowsheet(a.id)}
                      className="text-xs rounded bg-primary/20 px-2 py-1"
                    >
                      Flowsheet →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdmit && (
        <AdmitModal
          onClose={() => setShowAdmit(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ["icu", "admissions"] });
            setShowAdmit(false);
            onSelect(id);
          }}
        />
      )}
    </div>
  );
}

function KpiCard({
  label, value, tone,
}: { label: string; value: number; tone?: "warning" }) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        tone === "warning"
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-border bg-card"
      }`}
    >
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="text-3xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function AdmitModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const [form, setForm] = useState({
    patient_uid: "",
    unit_code: "MICU",
    bed_no: "",
    admitting_doctor_name: "",
    primary_diagnosis: "",
    reason_for_icu: "",
    apache_ii_score: "",
    sofa_score: "",
    expected_los_days: "",
    code_status: "full_code",
  });

  const m = useMutation({
    mutationFn: async () => {
      const body = {
        ...form,
        apache_ii_score: form.apache_ii_score ? Number(form.apache_ii_score) : undefined,
        sofa_score: form.sofa_score ? Number(form.sofa_score) : undefined,
        expected_los_days: form.expected_los_days ? Number(form.expected_los_days) : undefined,
      };
      const r = await fetchAdminAPI<unknown>("/icu/admissions", {
        method: "POST", body: body,
      });
      return unwrap<{ id: number }>(r);
    },
    onSuccess: (row) => onCreated(row.id),
  });

  const valid = form.patient_uid.trim().length > 0 && form.unit_code.trim().length > 0;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-6 space-y-4 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">New ICU Admission</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Patient UID *" value={form.patient_uid}
            onChange={(v) => setForm({ ...form, patient_uid: v })} />
          <Field label="Unit *" value={form.unit_code}
            onChange={(v) => setForm({ ...form, unit_code: v.toUpperCase() })}
            placeholder="MICU / SICU / CCU / PICU / NICU" />
          <Field label="Bed no." value={form.bed_no}
            onChange={(v) => setForm({ ...form, bed_no: v })} />
          <Field label="Admitting doctor" value={form.admitting_doctor_name}
            onChange={(v) => setForm({ ...form, admitting_doctor_name: v })} />
          <Field label="APACHE-II" value={form.apache_ii_score}
            onChange={(v) => setForm({ ...form, apache_ii_score: v })} type="number" />
          <Field label="SOFA (admit)" value={form.sofa_score}
            onChange={(v) => setForm({ ...form, sofa_score: v })} type="number" />
          <Field label="Expected LOS (days)" value={form.expected_los_days}
            onChange={(v) => setForm({ ...form, expected_los_days: v })} type="number" />
          <div>
            <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
              Code status
            </label>
            <select
              value={form.code_status}
              onChange={(e) => setForm({ ...form, code_status: e.target.value })}
              className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
            >
              <option value="full_code">Full Code</option>
              <option value="dni">DNI</option>
              <option value="dnr">DNR</option>
              <option value="dnr_dni">DNR / DNI</option>
              <option value="comfort_only">Comfort Only</option>
            </select>
          </div>
        </div>

        <Field label="Primary diagnosis" value={form.primary_diagnosis}
          onChange={(v) => setForm({ ...form, primary_diagnosis: v })} multiline />
        <Field label="Reason for ICU" value={form.reason_for_icu}
          onChange={(v) => setForm({ ...form, reason_for_icu: v })} multiline
          placeholder="e.g. septic shock req noradr 0.3 mcg/kg/min, ARDS PaO2/FiO2 120" />

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!valid || m.isPending}
            onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {m.isPending ? "Admitting…" : "Admit"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, type = "text", placeholder, multiline,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <div className={multiline ? "col-span-2" : ""}>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
        />
      )}
    </div>
  );
}
