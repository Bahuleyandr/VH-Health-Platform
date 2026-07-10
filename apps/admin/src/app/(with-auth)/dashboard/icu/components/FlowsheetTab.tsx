// src/app/(with-auth)/dashboard/icu/components/FlowsheetTab.tsx

"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";
import {
  FlowsheetEntry,
  IcuChartView,
  IoSummaryRow,
  fmtDateTime,
  unwrap,
  unwrapList,
} from "./types";
import { icuRefetchMs } from "../realtime";

export default function FlowsheetTab({
  admissionId,
  subscribed,
}: {
  admissionId: number;
  subscribed: boolean;
}) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [hours, setHours] = useState<number>(24);

  const { data: entries = [], isLoading } = useQuery<FlowsheetEntry[]>({
    queryKey: ["icu", "flowsheet", admissionId, hours],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        `/icu/admissions/${admissionId}/flowsheet?hours=${hours}`,
      );
      return unwrapList<FlowsheetEntry>(r);
    },
    refetchInterval: icuRefetchMs(subscribed, 30_000),
  });

  const { data: io = [] } = useQuery<IoSummaryRow[]>({
    queryKey: ["icu", "io", admissionId],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        `/icu/admissions/${admissionId}/io-summary`,
      );
      return unwrapList<IoSummaryRow>(r);
    },
  });

  const { data: chart } = useQuery<IcuChartView | null>({
    queryKey: ["icu", "chart", admissionId, hours],
    queryFn: async () => {
      const r = await fetchAdminAPI<unknown>(
        `/icu/admissions/${admissionId}/chart?hours=${hours}`,
      );
      return unwrap<IcuChartView>(r);
    },
    refetchInterval: icuRefetchMs(subscribed, 30_000),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground">Last:</label>
          <select
            value={hours}
            onChange={(e) => setHours(Number(e.target.value))}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value={6}>6 hours</option>
            <option value={12}>12 hours</option>
            <option value={24}>24 hours</option>
            <option value={48}>48 hours</option>
            <option value={72}>72 hours</option>
            <option value={168}>7 days</option>
          </select>
        </div>
        <button
          type="button"
          onClick={() => setShowAdd(true)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          + Hourly entry
        </button>
      </div>

      {chart && <IcuChartDepthPanel chart={chart} />}

      {/* I/O daily summary */}
      {io.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="px-3 py-2 text-xs uppercase tracking-wider text-muted-foreground bg-muted/40">
            I/O daily summary (running)
          </div>
          <table className="w-full text-sm">
            <thead className="text-muted-foreground">
              <tr>
                <th className="text-left p-2">Day</th>
                <th className="text-right p-2">IV</th>
                <th className="text-right p-2">Oral</th>
                <th className="text-right p-2">Blood</th>
                <th className="text-right p-2">Urine</th>
                <th className="text-right p-2">Drains</th>
                <th className="text-right p-2">NG</th>
                <th className="text-right p-2">Net</th>
                <th className="text-right p-2">Entries</th>
              </tr>
            </thead>
            <tbody>
              {io.map((row) => (
                <tr key={row.day} className="border-t border-border">
                  <td className="p-2">{row.day}</td>
                  <td className="p-2 text-right">{row.iv_fluids_ml}</td>
                  <td className="p-2 text-right">{row.oral_intake_ml}</td>
                  <td className="p-2 text-right">{row.blood_products_ml}</td>
                  <td className="p-2 text-right">{row.urine_output_ml}</td>
                  <td className="p-2 text-right">{row.drain_output_ml}</td>
                  <td className="p-2 text-right">{row.ng_aspirate_ml}</td>
                  <td
                    className={`p-2 text-right font-semibold ${
                      row.net_balance_ml > 1000
                        ? "text-amber-300"
                        : row.net_balance_ml < -1000
                          ? "text-rose-300"
                          : ""
                    }`}
                  >
                    {row.net_balance_ml >= 0 ? "+" : ""}
                    {row.net_balance_ml}
                  </td>
                  <td className="p-2 text-right text-muted-foreground">
                    {row.entries_logged}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isLoading && <LoadingSpinner />}
      {!isLoading && entries.length === 0 && (
        <EmptyState title="No flowsheet entries in this window. Click '+ Hourly entry' to start." />
      )}

      {entries.length > 0 && (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="text-xs min-w-[1100px]">
            <thead className="bg-muted/40 text-muted-foreground sticky top-0">
              <tr>
                <th className="p-2 text-left">Time</th>
                <th className="p-2">HR</th>
                <th className="p-2">BP</th>
                <th className="p-2">MAP</th>
                <th className="p-2">SpO₂</th>
                <th className="p-2">Temp</th>
                <th className="p-2">RR</th>
                <th className="p-2">GCS</th>
                <th className="p-2">Vent</th>
                <th className="p-2">FiO₂</th>
                <th className="p-2">PEEP</th>
                <th className="p-2">P/F</th>
                <th className="p-2">NorAdr</th>
                <th className="p-2">Adr</th>
                <th className="p-2">Propofol</th>
                <th className="p-2">In</th>
                <th className="p-2">Urine</th>
                <th className="p-2">Net</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="p-2 whitespace-nowrap">
                    {fmtDateTime(e.recorded_at)}
                  </td>
                  <td className="p-2 text-center">{e.hr ?? "—"}</td>
                  <td className="p-2 text-center">
                    {e.sbp != null && e.dbp != null ? `${e.sbp}/${e.dbp}` : "—"}
                  </td>
                  <td className="p-2 text-center">{e.map ?? "—"}</td>
                  <td className="p-2 text-center">{e.spo2 ?? "—"}</td>
                  <td className="p-2 text-center">{e.temp_c ?? "—"}</td>
                  <td className="p-2 text-center">{e.rr ?? "—"}</td>
                  <td className="p-2 text-center">{e.gcs_total ?? "—"}</td>
                  <td className="p-2 text-center">{e.vent_mode ?? "—"}</td>
                  <td className="p-2 text-center">{e.fio2_pct ?? "—"}</td>
                  <td className="p-2 text-center">{e.peep_cmh2o ?? "—"}</td>
                  <td
                    className={`p-2 text-center ${
                      e.pf_ratio != null && e.pf_ratio < 200
                        ? "text-rose-300 font-semibold"
                        : ""
                    }`}
                  >
                    {e.pf_ratio ?? "—"}
                  </td>
                  <td className="p-2 text-center">
                    {e.noradrenaline_mcg_kg_min ?? "—"}
                  </td>
                  <td className="p-2 text-center">
                    {e.adrenaline_mcg_kg_min ?? "—"}
                  </td>
                  <td className="p-2 text-center">
                    {e.propofol_mcg_kg_min ?? "—"}
                  </td>
                  <td className="p-2 text-center">{e.iv_fluids_ml ?? "—"}</td>
                  <td className="p-2 text-center">
                    {e.urine_output_ml ?? "—"}
                  </td>
                  <td
                    className={`p-2 text-center font-semibold ${
                      e.net_balance_ml != null && e.net_balance_ml > 0
                        ? "text-emerald-300"
                        : ""
                    }`}
                  >
                    {e.net_balance_ml ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <FlowsheetEntryModal
          admissionId={admissionId}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["icu", "flowsheet"] });
            qc.invalidateQueries({ queryKey: ["icu", "io"] });
            qc.invalidateQueries({ queryKey: ["icu", "chart"] });
            setShowAdd(false);
          }}
        />
      )}
    </div>
  );
}

function IcuChartDepthPanel({ chart }: { chart: IcuChartView }) {
  const activeLines = chart.line_presence.filter((row) => !row.stopped_at);
  const activeVent = chart.ventilation_episodes.find((row) => !row.stopped_at);
  const latestScore = chart.scoring_outputs[0];
  const latestDeviceVital = chart.device_vitals[chart.device_vitals.length - 1];

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted-foreground">
            ICU chart depth
          </div>
          <div className="text-sm text-muted-foreground">
            Device-source vitals, ventilation, line/tube/drain lifecycle, and
            score governance.
          </div>
        </div>
        <div className="flex gap-2 text-xs">
          <span className="rounded border border-border px-2 py-1">
            Device vitals {chart.summary.device_vitals_count}
          </span>
          <span
            className={
              chart.summary.unverified_device_vitals_count > 0
                ? "rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-amber-200"
                : "rounded border border-border px-2 py-1"
            }
          >
            Unverified {chart.summary.unverified_device_vitals_count}
          </span>
          <span className="rounded border border-border px-2 py-1">
            Active lines {chart.summary.active_line_count}
          </span>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-sm">
        <DepthBox
          label="Latest device vitals"
          value={
            latestDeviceVital
              ? `${latestDeviceVital.source_device ?? "device"} · ${fmtDateTime(latestDeviceVital.recorded_at)}`
              : "No device vitals"
          }
          detail={
            latestDeviceVital
              ? [
                  latestDeviceVital.heart_rate != null
                    ? `HR ${latestDeviceVital.heart_rate}`
                    : null,
                  latestDeviceVital.spo2 != null
                    ? `SpO₂ ${latestDeviceVital.spo2}`
                    : null,
                  latestDeviceVital.systolic_bp != null &&
                  latestDeviceVital.diastolic_bp != null
                    ? `BP ${latestDeviceVital.systolic_bp}/${latestDeviceVital.diastolic_bp}`
                    : null,
                  latestDeviceVital.device_verified === false
                    ? "unverified"
                    : "verified",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "NL-7 sources only; no gateway bypass samples."
          }
        />
        <DepthBox
          label="Ventilation"
          value={
            activeVent
              ? activeVent.mode.replaceAll("_", " ")
              : "No active episode"
          }
          detail={
            activeVent
              ? [
                  activeVent.oxygen_device,
                  activeVent.airway_type,
                  fmtDateTime(activeVent.started_at),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : `${chart.summary.ventilation_episode_count} episodes in window`
          }
        />
        <DepthBox
          label="Lines / tubes / drains"
          value={`${activeLines.length} active`}
          detail={
            activeLines.length > 0
              ? activeLines
                  .slice(0, 3)
                  .map((line) =>
                    [
                      line.display_label ||
                        line.presence_kind.replaceAll("_", " "),
                      line.denominator_device_type
                        ? `HAI: ${line.denominator_device_type}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" "),
                  )
                  .join(" · ")
              : "No active denominator devices in this window"
          }
        />
        <DepthBox
          label="Score outputs"
          value={
            latestScore
              ? latestScore.scoring_kind.toUpperCase()
              : "None recorded"
          }
          detail={
            latestScore
              ? [
                  latestScore.score_value ?? latestScore.score_label,
                  latestScore.review_status.replaceAll("_", " "),
                  latestScore.reference_version,
                  latestScore.order_mutation_performed
                    ? "order mutation flagged"
                    : "decision support only",
                ]
                  .filter(Boolean)
                  .join(" · ")
              : "RASS, SOFA, CPOT, and SBT outputs require reference + reviewer."
          }
        />
      </div>
    </div>
  );
}

function DepthBox({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded border border-border bg-background/60 p-3 min-h-[104px]">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground leading-relaxed">
        {detail}
      </div>
    </div>
  );
}

function FlowsheetEntryModal({
  admissionId,
  onClose,
  onSaved,
}: {
  admissionId: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({});

  const setField = (k: string) => (v: string) => setForm({ ...form, [k]: v });

  const m = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === "" || v == null) continue;
        const num = Number(v);
        body[k] =
          Number.isFinite(num) &&
          k !== "vent_mode" &&
          k !== "pupils_reactive" &&
          k !== "event_note"
            ? num
            : v;
      }
      const r = await fetchAdminAPI<unknown>(
        `/icu/admissions/${admissionId}/flowsheet`,
        { method: "POST", body: body },
      );
      return unwrap<FlowsheetEntry>(r);
    },
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-lg border border-border bg-card p-6 space-y-4 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">New hourly entry</h2>
          <button
            type="button"
            className="text-muted-foreground"
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <Section label="Vitals">
          <NumF label="HR" v={form.hr} on={setField("hr")} />
          <NumF label="SBP" v={form.sbp} on={setField("sbp")} />
          <NumF label="DBP" v={form.dbp} on={setField("dbp")} />
          <NumF label="MAP" v={form.map} on={setField("map")} />
          <NumF label="CVP" v={form.cvp} on={setField("cvp")} />
          <NumF label="SpO₂" v={form.spo2} on={setField("spo2")} />
          <NumF label="RR" v={form.rr} on={setField("rr")} />
          <NumF
            label="Temp °C"
            v={form.temp_c}
            on={setField("temp_c")}
            step="0.1"
          />
        </Section>

        <Section label="Neuro">
          <NumF label="GCS Eye" v={form.gcs_eye} on={setField("gcs_eye")} />
          <NumF
            label="GCS Verbal"
            v={form.gcs_verbal}
            on={setField("gcs_verbal")}
          />
          <NumF
            label="GCS Motor"
            v={form.gcs_motor}
            on={setField("gcs_motor")}
          />
          <NumF
            label="Pupils L (mm)"
            v={form.pupils_left_size_mm}
            on={setField("pupils_left_size_mm")}
            step="0.1"
          />
          <NumF
            label="Pupils R (mm)"
            v={form.pupils_right_size_mm}
            on={setField("pupils_right_size_mm")}
            step="0.1"
          />
          <TextF
            label="Pupils reactive"
            v={form.pupils_reactive}
            on={setField("pupils_reactive")}
            placeholder="both_brisk / left_sluggish"
          />
        </Section>

        <Section label="Ventilator">
          <TextF
            label="Mode"
            v={form.vent_mode}
            on={setField("vent_mode")}
            placeholder="cmv / simv / psv / cpap / spontaneous / off"
          />
          <NumF label="FiO₂ %" v={form.fio2_pct} on={setField("fio2_pct")} />
          <NumF
            label="PEEP"
            v={form.peep_cmh2o}
            on={setField("peep_cmh2o")}
            step="0.1"
          />
          <NumF
            label="Tidal Vol mL"
            v={form.tidal_volume_ml}
            on={setField("tidal_volume_ml")}
          />
          <NumF
            label="Set RR"
            v={form.resp_rate_set}
            on={setField("resp_rate_set")}
          />
          <NumF
            label="Peak P"
            v={form.airway_pressure_peak}
            on={setField("airway_pressure_peak")}
          />
          <NumF label="P/F ratio" v={form.pf_ratio} on={setField("pf_ratio")} />
        </Section>

        <Section label="Drips">
          <NumF
            label="Noradr mcg/kg/min"
            v={form.noradrenaline_mcg_kg_min}
            on={setField("noradrenaline_mcg_kg_min")}
            step="0.001"
          />
          <NumF
            label="Adr mcg/kg/min"
            v={form.adrenaline_mcg_kg_min}
            on={setField("adrenaline_mcg_kg_min")}
            step="0.001"
          />
          <NumF
            label="Vasopressin u/hr"
            v={form.vasopressin_units_hr}
            on={setField("vasopressin_units_hr")}
            step="0.01"
          />
          <NumF
            label="Dobutamine mcg/kg/min"
            v={form.dobutamine_mcg_kg_min}
            on={setField("dobutamine_mcg_kg_min")}
            step="0.001"
          />
          <NumF
            label="Propofol mcg/kg/min"
            v={form.propofol_mcg_kg_min}
            on={setField("propofol_mcg_kg_min")}
            step="0.001"
          />
          <NumF
            label="Midazolam mg/hr"
            v={form.midazolam_mg_hr}
            on={setField("midazolam_mg_hr")}
            step="0.01"
          />
          <NumF
            label="Fentanyl mcg/hr"
            v={form.fentanyl_mcg_hr}
            on={setField("fentanyl_mcg_hr")}
            step="0.01"
          />
          <NumF
            label="Insulin u/hr"
            v={form.insulin_units_hr}
            on={setField("insulin_units_hr")}
            step="0.1"
          />
        </Section>

        <Section label="I/O (this hour)">
          <NumF
            label="IV mL"
            v={form.iv_fluids_ml}
            on={setField("iv_fluids_ml")}
          />
          <NumF
            label="Oral mL"
            v={form.oral_intake_ml}
            on={setField("oral_intake_ml")}
          />
          <NumF
            label="Blood mL"
            v={form.blood_products_ml}
            on={setField("blood_products_ml")}
          />
          <NumF
            label="Urine mL"
            v={form.urine_output_ml}
            on={setField("urine_output_ml")}
          />
          <NumF
            label="Drains mL"
            v={form.drain_output_ml}
            on={setField("drain_output_ml")}
          />
          <NumF
            label="NG aspirate mL"
            v={form.ng_aspirate_ml}
            on={setField("ng_aspirate_ml")}
          />
          <NumF
            label="Stool count"
            v={form.stool_count}
            on={setField("stool_count")}
          />
        </Section>

        <div>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            Event note
          </label>
          <textarea
            value={form.event_note ?? ""}
            onChange={(e) => setField("event_note")(e.target.value)}
            rows={2}
            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
          />
        </div>

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={m.isPending}
            onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {m.isPending ? "Saving…" : "Save entry"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
        {label}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{children}</div>
    </div>
  );
}

function NumF({
  label,
  v,
  on,
  step,
}: {
  label: string;
  v: string | undefined;
  on: (s: string) => void;
  step?: string;
}) {
  return (
    <label className="text-xs">
      <span className="block text-muted-foreground mb-0.5">{label}</span>
      <input
        type="number"
        step={step}
        value={v ?? ""}
        onChange={(e) => on(e.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
      />
    </label>
  );
}

function TextF({
  label,
  v,
  on,
  placeholder,
}: {
  label: string;
  v: string | undefined;
  on: (s: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="text-xs">
      <span className="block text-muted-foreground mb-0.5">{label}</span>
      <input
        type="text"
        value={v ?? ""}
        onChange={(e) => on(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
      />
    </label>
  );
}
