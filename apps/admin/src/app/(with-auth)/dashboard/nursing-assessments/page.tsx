// src/app/(with-auth)/dashboard/nursing-assessments/page.tsx
//
// Sprint 15 — NEWS2 + Braden + Morse + sepsis screen dashboard.

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

interface OverdueRow {
  id: number;
  patient_uid: string;
  admission_id: number | null;
  assessment_kind: string;
  total_score: number | null;
  band: string;
  assessed_at: string;
  next_assessment_due_at: string | null;
  minutes_overdue: number;
}

interface ScoreResult {
  total_score: number;
  band: string;
  recommended_actions: string[];
  reassessmentMins?: number;
}

const BAND_COLOURS: Record<string, string> = {
  // NEWS2
  low: "bg-emerald-100 text-emerald-800",
  low_medium: "bg-amber-100 text-amber-800",
  medium: "bg-orange-100 text-orange-800",
  high: "bg-rose-200 text-rose-900",
  // Braden
  no_risk: "bg-emerald-100 text-emerald-800",
  mild_risk: "bg-amber-100 text-amber-800",
  moderate_risk: "bg-orange-100 text-orange-800",
  high_risk: "bg-rose-100 text-rose-800",
  severe_risk: "bg-rose-200 text-rose-900",
  // Morse
  low_risk: "bg-emerald-100 text-emerald-800",
  // Sepsis
  no_concern: "bg-emerald-100 text-emerald-800",
  monitor_closely: "bg-amber-100 text-amber-800",
  sepsis_likely: "bg-rose-100 text-rose-800",
  septic_shock_risk: "bg-rose-200 text-rose-900 font-bold",
};

const KIND_LABELS: Record<string, string> = {
  news2: "NEWS2",
  braden: "Braden",
  morse: "Morse Falls",
  sepsis_screen: "Sepsis screen",
};

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function fmtTs(s: string | null): string {
  if (!s) return "—";
  return new Date(s).toLocaleString();
}

export default function NursingAssessmentsPage() {
  const qc = useQueryClient();
  const [scoring, setScoring] = useState<{ kind: string } | null>(null);

  const { data: rows = [], isLoading, error } = useQuery<OverdueRow[]>({
    queryKey: ["nursing-assessments", "overdue"],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        "/nursing-assessments/dashboard/overdue-or-high-risk?limit=100",
      );
      return unwrapList<OverdueRow>(r);
    },
    refetchInterval: 60_000,
  });

  const errMsg = error instanceof Error ? error.message : null;

  // Counts by band severity for the headline strip.
  const counts = {
    septic_shock: rows.filter((r) => r.band === "septic_shock_risk").length,
    high: rows.filter((r) => r.band === "high" || r.band === "severe_risk").length,
    sepsis: rows.filter((r) => r.band === "sepsis_likely").length,
    medium: rows.filter((r) => r.band === "medium" || r.band === "moderate_risk" || r.band === "high_risk").length,
    overdue: rows.filter((r) => r.minutes_overdue > 0).length,
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            Nursing Assessments
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            NEWS2, Braden, Morse Falls, sepsis screen. Auto-refreshes every 60s.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {Object.entries(KIND_LABELS).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setScoring({ kind: k })}
              className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
            >
              + {label}
            </button>
          ))}
          <button
            onClick={() =>
              qc.invalidateQueries({ queryKey: ["nursing-assessments"] })
            }
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted"
          >
            Refresh
          </button>
        </div>
      </div>

      {errMsg && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {errMsg}
        </div>
      )}

      {/* Severity counts */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Tile
          label="Septic shock risk"
          value={counts.septic_shock}
          colour="rose"
        />
        <Tile label="High / severe risk" value={counts.high} colour="rose" />
        <Tile label="Sepsis likely" value={counts.sepsis} colour="rose" />
        <Tile label="Medium / moderate" value={counts.medium} colour="amber" />
        <Tile label="Overdue reassessment" value={counts.overdue} colour="amber" />
      </div>

      {/* Active list */}
      {isLoading ? (
        <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState
          title="All clear"
          description="No high-risk patients or overdue reassessments right now."
        />
      ) : (
        <div className="bg-white rounded-lg border shadow-sm overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="text-xs text-muted-foreground border-b">
              <tr className="text-left">
                <th className="px-3 py-2">Patient</th>
                <th className="px-3 py-2">Kind</th>
                <th className="px-3 py-2">Score</th>
                <th className="px-3 py-2">Band</th>
                <th className="px-3 py-2">Assessed</th>
                <th className="px-3 py-2">Next due</th>
                <th className="px-3 py-2">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className={`border-b last:border-0 ${
                    r.band === "septic_shock_risk" ||
                    r.band === "high" ||
                    r.band === "severe_risk"
                      ? "bg-rose-50/50"
                      : ""
                  }`}
                >
                  <td className="px-3 py-2 text-xs font-mono">
                    {r.patient_uid.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {KIND_LABELS[r.assessment_kind] ?? r.assessment_kind}
                  </td>
                  <td className="px-3 py-2 font-mono">{r.total_score ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-xs ${
                        BAND_COLOURS[r.band] ?? ""
                      }`}
                    >
                      {r.band.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs">{fmtTs(r.assessed_at)}</td>
                  <td className="px-3 py-2 text-xs">
                    {fmtTs(r.next_assessment_due_at)}
                  </td>
                  <td
                    className={`px-3 py-2 text-xs font-mono ${
                      r.minutes_overdue > 0 ? "text-rose-700 font-semibold" : ""
                    }`}
                  >
                    {r.minutes_overdue > 0
                      ? `+${Math.round(r.minutes_overdue)}m`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {scoring && (
        <ScoreModal
          kind={scoring.kind}
          onClose={() => setScoring(null)}
          onSaved={() => {
            setScoring(null);
            qc.invalidateQueries({ queryKey: ["nursing-assessments"] });
          }}
        />
      )}
    </div>
  );
}

function Tile({
  label, value, colour,
}: {
  label: string;
  value: number;
  colour: "rose" | "amber" | "default";
}) {
  const cls =
    colour === "rose" && value > 0
      ? "border-rose-300"
      : colour === "amber" && value > 0
        ? "border-amber-300"
        : "";
  return (
    <div className={`bg-white rounded-lg border shadow-sm p-3 ${cls}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-xl font-semibold mt-1 ${
          colour === "rose" && value > 0
            ? "text-rose-700"
            : colour === "amber" && value > 0
              ? "text-amber-700"
              : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}

interface FieldDef {
  name: string;
  label: string;
  kind: "number" | "bool" | "enum";
  options?: { value: string; label: string }[];
  hint?: string;
}

const FIELDS: Record<string, FieldDef[]> = {
  news2: [
    { name: "rr", label: "Respiratory rate", kind: "number" },
    { name: "spo2", label: "SpO2 (%)", kind: "number" },
    { name: "spo2_scale", label: "SpO2 scale", kind: "enum", options: [
      { value: "1", label: "Scale 1 (normal target)" },
      { value: "2", label: "Scale 2 (COPD target 88-92%)" },
    ] },
    { name: "supplemental_o2", label: "On supplemental O2", kind: "bool" },
    { name: "temp_c", label: "Temperature (°C)", kind: "number" },
    { name: "sbp", label: "Systolic BP", kind: "number" },
    { name: "hr", label: "Heart rate", kind: "number" },
    { name: "consciousness", label: "Consciousness", kind: "enum", options: [
      { value: "awake", label: "Alert" },
      { value: "V", label: "Voice (V)" },
      { value: "P", label: "Pain (P)" },
      { value: "U", label: "Unresponsive (U)" },
    ] },
  ],
  braden: [
    { name: "sensory", label: "Sensory perception", kind: "number", hint: "1 (completely limited) – 4 (no impairment)" },
    { name: "moisture", label: "Moisture", kind: "number", hint: "1 – 4" },
    { name: "activity", label: "Activity", kind: "number", hint: "1 – 4" },
    { name: "mobility", label: "Mobility", kind: "number", hint: "1 – 4" },
    { name: "nutrition", label: "Nutrition", kind: "number", hint: "1 – 4" },
    { name: "friction", label: "Friction & shear", kind: "number", hint: "1 – 3" },
  ],
  morse: [
    { name: "history_falls", label: "History of falls (within 3 months)", kind: "bool" },
    { name: "secondary_dx", label: "Secondary diagnosis", kind: "bool" },
    { name: "ambulatory_aid", label: "Ambulatory aid", kind: "enum", options: [
      { value: "none", label: "None / bedrest / wheelchair / nurse" },
      { value: "crutches_cane_walker", label: "Crutches / cane / walker" },
      { value: "furniture", label: "Holds onto furniture" },
    ] },
    { name: "iv_therapy", label: "IV therapy / saline lock", kind: "bool" },
    { name: "gait", label: "Gait", kind: "enum", options: [
      { value: "normal_or_bedrest", label: "Normal / bedrest / wheelchair" },
      { value: "weak", label: "Weak" },
      { value: "impaired", label: "Impaired" },
    ] },
    { name: "mental_status", label: "Mental status", kind: "enum", options: [
      { value: "oriented", label: "Oriented to own ability" },
      { value: "forgets_limits", label: "Overestimates / forgets limits" },
    ] },
  ],
  sepsis_screen: [
    { name: "rr_over_22", label: "Respiratory rate > 22", kind: "bool" },
    { name: "hr_over_90", label: "Heart rate > 90", kind: "bool" },
    { name: "temp_abnormal", label: "Temp < 36 or > 38", kind: "bool" },
    { name: "wbc_abnormal", label: "WBC < 4 or > 12 (or > 10% bands)", kind: "bool" },
    { name: "altered_mentation", label: "Altered mentation (GCS < 15)", kind: "bool" },
    { name: "sbp_under_100", label: "SBP < 100", kind: "bool" },
    { name: "lactate_over_2", label: "Lactate > 2 mmol/L", kind: "bool" },
    { name: "source_suspected", label: "Suspected source of infection", kind: "bool" },
  ],
};

function ScoreModal({
  kind, onClose, onSaved,
}: {
  kind: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [patientUid, setPatientUid] = useState("");
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [preview, setPreview] = useState<ScoreResult | null>(null);
  const [notes, setNotes] = useState("");
  const fields = FIELDS[kind] ?? [];

  const previewMut = useMutation({
    mutationFn: async () => {
      const r = await fetchAdminAPI<unknown>("/nursing-assessments/score", {
        method: "POST",
        body: JSON.stringify({ kind, inputs }),
      });
      return unwrap<ScoreResult>(r);
    },
    onSuccess: (data) => setPreview(data),
  });

  const recordMut = useMutation({
    mutationFn: async () =>
      fetchAdminAPI("/nursing-assessments", {
        method: "POST",
        body: JSON.stringify({
          patient_uid: patientUid,
          assessment_kind: kind,
          inputs,
          notes: notes || undefined,
        }),
      }),
    onSuccess: onSaved,
  });

  const errMsg = (previewMut.error ?? recordMut.error)?.toString();

  return (
    <div className="fixed inset-0 bg-black/40 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-2xl mb-8">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="text-lg font-semibold">
            New {KIND_LABELS[kind]} assessment
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="p-4 space-y-3 max-h-[65vh] overflow-y-auto">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Patient UID *
            </label>
            <input
              value={patientUid}
              onChange={(e) => setPatientUid(e.target.value)}
              placeholder="UUID"
              className="w-full border border-border rounded-lg px-3 py-2 text-sm font-mono"
            />
          </div>
          <hr />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {fields.map((f) => (
              <FieldInput
                key={f.name}
                field={f}
                value={inputs[f.name]}
                onChange={(v) => {
                  setInputs({ ...inputs, [f.name]: v });
                  setPreview(null);
                }}
              />
            ))}
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">
              Notes
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full border border-border rounded-lg px-3 py-2 text-sm"
            />
          </div>

          <button
            onClick={() => previewMut.mutate()}
            disabled={previewMut.isPending}
            className="px-3 py-2 rounded-md border text-sm hover:bg-muted disabled:opacity-40"
          >
            {previewMut.isPending ? "Calculating…" : "Preview score"}
          </button>

          {preview && (
            <div
              className={`rounded-lg border p-3 ${
                BAND_COLOURS[preview.band]?.includes("rose")
                  ? "bg-rose-50 border-rose-300"
                  : BAND_COLOURS[preview.band]?.includes("amber")
                    ? "bg-amber-50 border-amber-300"
                    : "bg-emerald-50 border-emerald-300"
              }`}
            >
              <p className="text-sm font-semibold">
                Score {preview.total_score} —{" "}
                <span className="uppercase">{preview.band.replace(/_/g, " ")}</span>
              </p>
              {preview.reassessmentMins != null && (
                <p className="text-xs mt-1">
                  Reassess in: {preview.reassessmentMins < 60 ? `${preview.reassessmentMins}m` : `${(preview.reassessmentMins / 60).toFixed(0)}h`}
                </p>
              )}
              {preview.recommended_actions?.length > 0 && (
                <ul className="text-xs mt-2 list-disc list-inside">
                  {preview.recommended_actions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

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
            onClick={() => recordMut.mutate()}
            disabled={recordMut.isPending || !patientUid}
            className="px-3 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-40"
          >
            {recordMut.isPending ? "Recording…" : "Record assessment"}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({
  field, value, onChange,
}: {
  field: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  if (field.kind === "bool") {
    return (
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.label}</span>
      </label>
    );
  }
  if (field.kind === "enum") {
    return (
      <div>
        <label className="text-xs text-muted-foreground block mb-1">
          {field.label}
        </label>
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value || undefined)}
          className="w-full border border-border rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Select…</option>
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {field.hint && (
          <p className="text-xs text-muted-foreground mt-0.5">{field.hint}</p>
        )}
      </div>
    );
  }
  return (
    <div>
      <label className="text-xs text-muted-foreground block mb-1">
        {field.label}
      </label>
      <input
        type="number"
        step="0.1"
        value={value == null ? "" : String(value)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === "" ? undefined : Number(v));
        }}
        className="w-full border border-border rounded-lg px-3 py-2 text-sm"
      />
      {field.hint && (
        <p className="text-xs text-muted-foreground mt-0.5">{field.hint}</p>
      )}
    </div>
  );
}
