// src/app/(with-auth)/dashboard/death-certification/page.tsx
//
// Sprint 21 — Death certification (MCCD Form 4) + mortality review.

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

interface DeathRecord {
  id: number;
  patient_uid: string;
  mccd_serial: string | null;
  date_of_death: string;
  time_of_death: string;
  place_of_death: string;
  ward_or_unit: string | null;
  cause_part_1a: string;
  cause_part_1b: string | null;
  cause_part_1c: string | null;
  cause_part_2: string | null;
  manner_of_death: string;
  was_pregnancy_related: boolean;
  was_postsurgery: boolean;
  surgery_within_30d: boolean;
  is_medicolegal: boolean;
  police_station: string | null;
  police_fir_no: string | null;
  police_clearance_at: string | null;
  postmortem_required: boolean;
  postmortem_completed_at: string | null;
  body_released_at: string | null;
  body_released_to_name: string | null;
  body_released_to_relation: string | null;
  certified_by_name: string | null;
  certifier_registration_no: string | null;
  certified_at: string | null;
  status: string;
  registrar_acknowledgement_no: string | null;
  registered_at: string | null;
  reviews?: MortalityReview[];
}

interface MortalityReview {
  id: number;
  review_date: string;
  preventability: string | null;
  cause_classification: string | null;
  factor_disease: boolean;
  factor_communication: boolean;
  factor_documentation: boolean;
  factor_diagnostic_delay: boolean;
  factor_treatment_delay: boolean;
  factor_medication: boolean;
  factor_procedural: boolean;
  factor_supervision: boolean;
  factor_resource: boolean;
  factor_handover: boolean;
  discussion_summary: string | null;
  learning_points: string | null;
  action_items: string[] | null;
  status: string;
  finalised_at: string | null;
}

interface MortalitySummary {
  total_deaths: number;
  registered_count: number;
  medicolegal_count: number;
  maternal_deaths: number;
  surgical_30d_deaths: number;
  reviews_done: number;
  reviews_preventable: number;
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

function unwrapList<T>(r: unknown): T[] {
  const data = (r as { data?: unknown }).data ?? r;
  return Array.isArray(data) ? (data as T[]) : [];
}

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  certified: "Certified",
  submitted_to_registrar: "Submitted to Registrar",
  registered: "Registered",
  cancelled: "Cancelled",
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300",
  certified: "bg-blue-500/15 text-blue-300",
  submitted_to_registrar: "bg-indigo-500/15 text-indigo-300",
  registered: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-rose-500/15 text-rose-300",
};

export default function DeathCertificationPage() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [statusFilter, setStatusFilter] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: list = [], isLoading } = useQuery<DeathRecord[]>({
    queryKey: ["death", "list", statusFilter],
    queryFn: async () => {
      const q = statusFilter ? `?status=${statusFilter}` : "";
      return unwrapList<DeathRecord>(
        await fetchAdminAPI<unknown>(`/death-certification/records${q}`),
      );
    },
    refetchInterval: 60_000,
  });

  const { data: summary } = useQuery<MortalitySummary>({
    queryKey: ["death", "summary"],
    queryFn: async () => unwrap<MortalitySummary>(
      await fetchAdminAPI<unknown>(`/death-certification/summary-30d`),
    ),
  });

  const { data: detail } = useQuery<DeathRecord>({
    queryKey: ["death", "detail", selectedId],
    queryFn: async () => unwrap<DeathRecord>(
      await fetchAdminAPI<unknown>(`/death-certification/records/${selectedId}`),
    ),
    enabled: selectedId != null,
  });

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Death Certification</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Form 4 / MCCD per RBD Act 1969, body release with medicolegal
          checks, and post-event Mortality &amp; Morbidity review (NABH).
        </p>
      </div>

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
          <KpiCard label="30d total" value={summary.total_deaths} />
          <KpiCard label="Registered" value={summary.registered_count} />
          <KpiCard label="Medicolegal" value={summary.medicolegal_count} tone="warning" />
          <KpiCard label="Maternal" value={summary.maternal_deaths} tone="warning" />
          <KpiCard label="Post-op (30d)" value={summary.surgical_30d_deaths} />
          <KpiCard label="Reviews done" value={summary.reviews_done} />
          <KpiCard label="Preventable" value={summary.reviews_preventable} tone="warning" />
        </div>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground">Status:</label>
          <select value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm">
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="certified">Certified</option>
            <option value="submitted_to_registrar">Submitted</option>
            <option value="registered">Registered</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <button type="button"
          onClick={() => setShowCreate(true)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">
          + New death record
        </button>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && list.length === 0 && (
        <EmptyState title="No death records in this view." />
      )}

      {list.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">MCCD</th>
                <th className="text-left p-3">Patient</th>
                <th className="text-left p-3">Date / Place</th>
                <th className="text-left p-3">Cause (Ia)</th>
                <th className="text-left p-3">Manner</th>
                <th className="text-left p-3">Flags</th>
                <th className="text-left p-3">Status</th>
                <th className="text-left p-3">Body</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="p-3 font-mono text-xs">
                    {r.mccd_serial ?? <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="p-3 font-mono text-xs">{r.patient_uid.slice(0, 8)}…</td>
                  <td className="p-3 text-xs">
                    {r.date_of_death} {r.time_of_death}
                    <br />
                    <span className="text-muted-foreground uppercase">{r.place_of_death}</span>
                  </td>
                  <td className="p-3 max-w-[16rem] truncate" title={r.cause_part_1a}>
                    {r.cause_part_1a}
                  </td>
                  <td className="p-3 text-xs uppercase">{r.manner_of_death}</td>
                  <td className="p-3 text-xs">
                    {r.is_medicolegal && <span className="bg-rose-500/20 text-rose-300 px-1.5 py-0.5 rounded mr-1">MLC</span>}
                    {r.was_pregnancy_related && <span className="bg-fuchsia-500/20 text-fuchsia-300 px-1.5 py-0.5 rounded mr-1">M</span>}
                    {r.surgery_within_30d && <span className="bg-amber-500/20 text-amber-300 px-1.5 py-0.5 rounded mr-1">Op-30d</span>}
                  </td>
                  <td className="p-3">
                    <span className={`px-2 py-0.5 rounded text-xs ${STATUS_TONE[r.status] ?? ""}`}>
                      {STATUS_LABEL[r.status] ?? r.status}
                    </span>
                  </td>
                  <td className="p-3 text-xs">
                    {r.body_released_at
                      ? <span className="text-emerald-400">Released</span>
                      : <span className="text-amber-400">Pending</span>}
                  </td>
                  <td className="p-3 text-right">
                    <button type="button" onClick={() => setSelectedId(r.id)}
                      className="text-xs underline">
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateDeathModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            qc.invalidateQueries({ queryKey: ["death"] });
            setShowCreate(false);
            setSelectedId(id);
          }}
        />
      )}

      {selectedId && detail && (
        <DetailModal
          rec={detail}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            qc.invalidateQueries({ queryKey: ["death"] });
          }}
        />
      )}
    </div>
  );
}

// ── New death modal ─────────────────────────────────────────────────

function CreateDeathModal({
  onClose, onCreated,
}: { onClose: () => void; onCreated: (id: number) => void }) {
  const [form, setForm] = useState<Record<string, string | boolean>>({
    patient_uid: "",
    date_of_death: new Date().toISOString().slice(0, 10),
    time_of_death: new Date().toTimeString().slice(0, 5),
    place_of_death: "inpatient",
    ward_or_unit: "",
    cause_part_1a: "",
    icd10_part_1a: "",
    cause_part_1b: "",
    icd10_part_1b: "",
    cause_part_1c: "",
    icd10_part_1c: "",
    cause_part_2: "",
    icd10_part_2: "",
    manner_of_death: "natural",
    was_pregnancy_related: false,
    pregnancy_stage: "",
    was_postsurgery: false,
    surgery_within_30d: false,
    is_medicolegal: false,
    police_station: "",
    police_fir_no: "",
    postmortem_required: false,
    notes: "",
  });

  const setF = (k: string, v: string | boolean) => setForm({ ...form, [k]: v });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetchAdminAPI<unknown>("/death-certification/records", {
        method: "POST", body: form,
      });
      return unwrap<{ id: number }>(r);
    },
    onSuccess: (row) => onCreated(row.id),
  });

  const valid = form.patient_uid && form.date_of_death && form.time_of_death && form.cause_part_1a;

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-lg border border-border bg-card p-6 space-y-4 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">New death record</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <Section label="Patient + event">
          <Field2 label="Patient UID *" v={form.patient_uid as string}
            on={(v) => setF("patient_uid", v)} />
          <Field2 label="Date of death *" v={form.date_of_death as string} type="date"
            on={(v) => setF("date_of_death", v)} />
          <Field2 label="Time of death *" v={form.time_of_death as string} type="time"
            on={(v) => setF("time_of_death", v)} />
          <SelectF label="Place of death" v={form.place_of_death as string}
            on={(v) => setF("place_of_death", v)} options={[
              ["inpatient", "Inpatient"],
              ["emergency", "Emergency"],
              ["icu", "ICU"],
              ["or", "Operating Room"],
              ["home_brought_dead", "Brought dead"],
              ["transferred_out_dead", "Died on transfer"],
            ]} />
          <Field2 label="Ward / Unit" v={form.ward_or_unit as string}
            on={(v) => setF("ward_or_unit", v)} />
        </Section>

        <Section label="Cause of death (WHO ICD-10 format)">
          <Field2 label="Ia immediate cause *" v={form.cause_part_1a as string}
            on={(v) => setF("cause_part_1a", v)} multiline />
          <Field2 label="Ia ICD-10" v={form.icd10_part_1a as string}
            on={(v) => setF("icd10_part_1a", v)} placeholder="e.g. I21.9" />
          <Field2 label="Ib intermediate" v={form.cause_part_1b as string}
            on={(v) => setF("cause_part_1b", v)} multiline />
          <Field2 label="Ib ICD-10" v={form.icd10_part_1b as string}
            on={(v) => setF("icd10_part_1b", v)} />
          <Field2 label="Ic underlying" v={form.cause_part_1c as string}
            on={(v) => setF("cause_part_1c", v)} multiline />
          <Field2 label="Ic ICD-10" v={form.icd10_part_1c as string}
            on={(v) => setF("icd10_part_1c", v)} />
          <Field2 label="II contributory" v={form.cause_part_2 as string}
            on={(v) => setF("cause_part_2", v)} multiline />
          <Field2 label="II ICD-10" v={form.icd10_part_2 as string}
            on={(v) => setF("icd10_part_2", v)} />
        </Section>

        <Section label="Manner + special situations">
          <SelectF label="Manner of death *" v={form.manner_of_death as string}
            on={(v) => setF("manner_of_death", v)} options={[
              ["natural", "Natural"],
              ["accident", "Accident"],
              ["suicide", "Suicide"],
              ["homicide", "Homicide"],
              ["pending", "Pending investigation"],
              ["undetermined", "Undetermined"],
            ]} />
          <Check label="Pregnancy-related" v={form.was_pregnancy_related as boolean}
            on={(v) => setF("was_pregnancy_related", v)} />
          {form.was_pregnancy_related && (
            <SelectF label="Pregnancy stage" v={form.pregnancy_stage as string}
              on={(v) => setF("pregnancy_stage", v)} options={[
                ["", "—"],
                ["antenatal", "Antenatal"],
                ["intrapartum", "Intrapartum"],
                ["postpartum_42d", "Postpartum (≤42d)"],
              ]} />
          )}
          <Check label="Surgical procedure during admission" v={form.was_postsurgery as boolean}
            on={(v) => setF("was_postsurgery", v)} />
          <Check label="Surgery within 30 days of death" v={form.surgery_within_30d as boolean}
            on={(v) => setF("surgery_within_30d", v)} />
        </Section>

        <Section label="Medicolegal + postmortem">
          <Check label="Medicolegal case" v={form.is_medicolegal as boolean}
            on={(v) => setF("is_medicolegal", v)} />
          {form.is_medicolegal && (
            <>
              <Field2 label="Police station" v={form.police_station as string}
                on={(v) => setF("police_station", v)} />
              <Field2 label="FIR no." v={form.police_fir_no as string}
                on={(v) => setF("police_fir_no", v)} />
            </>
          )}
          <Check label="Postmortem required" v={form.postmortem_required as boolean}
            on={(v) => setF("postmortem_required", v)} />
        </Section>

        <Field2 label="Notes" v={form.notes as string} multiline
          on={(v) => setF("notes", v)} />

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!valid || m.isPending} onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Saving…" : "Create record"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Detail modal: certify / submit / register / body release / review

function DetailModal({
  rec, onClose, onChanged,
}: {
  rec: DeathRecord;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [section, setSection] = useState<"workflow" | "release" | "review">("workflow");

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-4xl rounded-lg border border-border bg-card p-6 space-y-4 my-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold">
              {rec.mccd_serial ?? `Death record #${rec.id}`}
            </h2>
            <div className="text-xs text-muted-foreground">
              {rec.date_of_death} {rec.time_of_death} · {rec.place_of_death}
              {rec.ward_or_unit && ` / ${rec.ward_or_unit}`}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={`px-2 py-0.5 rounded text-xs ${STATUS_TONE[rec.status] ?? ""}`}>
              {STATUS_LABEL[rec.status] ?? rec.status}
            </span>
            <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
          </div>
        </div>

        <div className="rounded border border-border p-3 text-sm space-y-1">
          <div><strong>Ia:</strong> {rec.cause_part_1a}</div>
          {rec.cause_part_1b && <div><strong>Ib:</strong> {rec.cause_part_1b}</div>}
          {rec.cause_part_1c && <div><strong>Ic:</strong> {rec.cause_part_1c}</div>}
          {rec.cause_part_2 && <div><strong>II:</strong> {rec.cause_part_2}</div>}
          <div className="text-muted-foreground text-xs">
            Manner: {rec.manner_of_death}
            {rec.is_medicolegal && (
              <> · MLC: {rec.police_station} / {rec.police_fir_no}
                {rec.police_clearance_at ? " (cleared)" : " (NO CLEARANCE)"}</>
            )}
          </div>
        </div>

        <div className="flex gap-2 border-b border-border">
          {([
            ["workflow", "Workflow"],
            ["release", "Body release"],
            ["review", "Mortality review"],
          ] as const).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setSection(k)}
              className={`px-3 py-1.5 text-sm border-b-2 -mb-px ${
                section === k
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {section === "workflow" && (
          <WorkflowSection rec={rec} onChanged={onChanged} />
        )}
        {section === "release" && (
          <ReleaseSection rec={rec} onChanged={onChanged} />
        )}
        {section === "review" && (
          <ReviewSection rec={rec} onChanged={onChanged} />
        )}
      </div>
    </div>
  );
}

function WorkflowSection({ rec, onChanged }: { rec: DeathRecord; onChanged: () => void }) {
  const [certName, setCertName] = useState(rec.certified_by_name ?? "");
  const [regNo, setRegNo] = useState(rec.certifier_registration_no ?? "");
  const [ackNo, setAckNo] = useState(rec.registrar_acknowledgement_no ?? "");

  const NEXT: Record<string, Array<[string, string]>> = {
    pending: [["certified", "Certify"], ["cancelled", "Cancel"]],
    certified: [["submitted_to_registrar", "Submit to Registrar"]],
    submitted_to_registrar: [["registered", "Mark Registered"]],
  };

  const transitions = NEXT[rec.status] ?? [];

  const m = useMutation({
    mutationFn: async (input: {
      to_status: string;
      certifier_name?: string;
      registration_no?: string;
      ack_no?: string;
    }) => fetchAdminAPI<unknown>(
      `/death-certification/records/${rec.id}/transition`,
      { method: "POST", body: input },
    ),
    onSuccess: () => onChanged(),
  });

  return (
    <div className="space-y-4">
      {rec.status === "pending" && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Field2 label="Certifier name *" v={certName} on={setCertName} />
          <Field2 label="MCI / Council reg no. *" v={regNo} on={setRegNo} />
        </div>
      )}

      {rec.status === "submitted_to_registrar" && (
        <Field2 label="Registrar acknowledgement no. *" v={ackNo} on={setAckNo} />
      )}

      {m.error instanceof Error && (
        <div className="text-sm text-rose-400">{m.error.message}</div>
      )}

      {transitions.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {transitions.map(([to, label]) => (
            <button
              key={to}
              type="button"
              disabled={m.isPending}
              onClick={() =>
                m.mutate({
                  to_status: to,
                  certifier_name: to === "certified" ? certName : undefined,
                  registration_no: to === "certified" ? regNo : undefined,
                  ack_no: to === "registered" ? ackNo : undefined,
                })
              }
              className={`rounded px-4 py-2 text-sm ${
                to === "cancelled"
                  ? "border border-rose-500/40 text-rose-300"
                  : "bg-primary text-primary-foreground"
              } disabled:opacity-50`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">
          Workflow complete — record is {STATUS_LABEL[rec.status] ?? rec.status}.
          {rec.registered_at && (
            <> Registered on {new Date(rec.registered_at).toLocaleDateString()}.</>
          )}
        </div>
      )}
    </div>
  );
}

function ReleaseSection({ rec, onChanged }: { rec: DeathRecord; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [idProof, setIdProof] = useState("");
  const [method, setMethod] = useState("family");
  const [firNo, setFirNo] = useState(rec.police_fir_no ?? "");
  const [station, setStation] = useState(rec.police_station ?? "");

  const release = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/death-certification/records/${rec.id}/body-release`,
      {
        method: "POST",
        body: {
          body_released_to_name: name,
          body_released_to_relation: relation,
          body_released_to_id_proof: idProof,
          body_release_method: method,
        },
      }),
    onSuccess: () => onChanged(),
  });

  const policeClear = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/death-certification/records/${rec.id}/police-clearance`,
      {
        method: "POST",
        body: { fir_no: firNo, station },
      }),
    onSuccess: () => onChanged(),
  });

  if (rec.body_released_at) {
    return (
      <div className="rounded bg-emerald-500/10 p-4 text-sm space-y-1">
        <div className="font-semibold">Body released</div>
        <div>To: {rec.body_released_to_name} ({rec.body_released_to_relation})</div>
        <div className="text-muted-foreground text-xs">
          {new Date(rec.body_released_at).toLocaleString()}
        </div>
      </div>
    );
  }

  if (rec.is_medicolegal && !rec.police_clearance_at) {
    return (
      <div className="space-y-3">
        <div className="rounded border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
          ⚠ Medicolegal case. Body cannot be released without police clearance
          per CrPC §174. Record clearance below first.
        </div>
        <Field2 label="Police station" v={station} on={setStation} />
        <Field2 label="FIR no." v={firNo} on={setFirNo} />
        {policeClear.error instanceof Error && (
          <div className="text-sm text-rose-400">{policeClear.error.message}</div>
        )}
        <button type="button" disabled={policeClear.isPending}
          onClick={() => policeClear.mutate()}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {policeClear.isPending ? "Recording…" : "Record police clearance"}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field2 label="Released to (name) *" v={name} on={setName} />
      <Field2 label="Relation *" v={relation} on={setRelation}
        placeholder="spouse / son / daughter / parent / sibling / other" />
      <Field2 label="ID proof (last 4 of Aadhaar / passport)" v={idProof} on={setIdProof} />
      <SelectF label="Method" v={method} on={setMethod} options={[
        ["family", "Family"],
        ["mortuary_van", "Mortuary van"],
        ["unclaimed_to_municipality", "Unclaimed (to municipality)"],
      ]} />

      {release.error instanceof Error && (
        <div className="text-sm text-rose-400">{release.error.message}</div>
      )}

      <button type="button"
        disabled={!name.trim() || !relation.trim() || release.isPending}
        onClick={() => release.mutate()}
        className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {release.isPending ? "Recording…" : "Record body release"}
      </button>
    </div>
  );
}

function ReviewSection({ rec, onChanged }: { rec: DeathRecord; onChanged: () => void }) {
  const review = rec.reviews?.[0] ?? null;
  const [form, setForm] = useState<Partial<MortalityReview>>(() => review ?? {});
  const [actionInput, setActionInput] = useState("");

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/death-certification/records/${rec.id}/review`,
      { method: "POST", body: form },
    ),
    onSuccess: () => onChanged(),
  });

  const finalise = useMutation({
    mutationFn: async () => {
      if (!review) throw new Error("save first");
      return fetchAdminAPI<unknown>(
        `/death-certification/reviews/${review.id}/finalise`,
        { method: "POST", body: {} },
      );
    },
    onSuccess: () => onChanged(),
  });

  const setF = <K extends keyof MortalityReview>(k: K, v: MortalityReview[K]) =>
    setForm((s) => ({ ...s, [k]: v }));

  const factorChecks: Array<[keyof MortalityReview, string]> = [
    ["factor_disease", "Disease severity"],
    ["factor_communication", "Communication"],
    ["factor_documentation", "Documentation"],
    ["factor_diagnostic_delay", "Diagnostic delay"],
    ["factor_treatment_delay", "Treatment delay"],
    ["factor_medication", "Medication-related"],
    ["factor_procedural", "Procedural-related"],
    ["factor_supervision", "Supervision"],
    ["factor_resource", "Resource (staffing / equipment)"],
    ["factor_handover", "Handover failure"],
  ];

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Preventability (consensus)
        </label>
        <select
          value={(form.preventability ?? "") as string}
          onChange={(e) => setF("preventability", e.target.value as MortalityReview["preventability"])}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">—</option>
          <option value="not_preventable">Not preventable</option>
          <option value="possibly_preventable">Possibly preventable</option>
          <option value="probably_preventable">Probably preventable</option>
          <option value="definitely_preventable">Definitely preventable</option>
        </select>
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Cause classification
        </label>
        <select
          value={(form.cause_classification ?? "") as string}
          onChange={(e) => setF("cause_classification", e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="">—</option>
          <option value="disease_progression">Disease progression</option>
          <option value="complication_of_treatment">Complication of treatment</option>
          <option value="medication_error">Medication error</option>
          <option value="surgical_complication">Surgical complication</option>
          <option value="system_failure">System failure</option>
          <option value="comorbidity">Comorbidity</option>
        </select>
      </div>

      <div>
        <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">
          Contributing factors (NABH categories)
        </div>
        <div className="grid grid-cols-2 gap-2">
          {factorChecks.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={Boolean(form[k])}
                onChange={(e) => setF(k, e.target.checked as never)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Discussion summary
        </label>
        <textarea rows={3} value={(form.discussion_summary as string) ?? ""}
          onChange={(e) => setF("discussion_summary", e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Learning points
        </label>
        <textarea rows={2} value={(form.learning_points as string) ?? ""}
          onChange={(e) => setF("learning_points", e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      </div>

      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Action items
        </label>
        <div className="flex gap-2">
          <input type="text" value={actionInput}
            onChange={(e) => setActionInput(e.target.value)}
            placeholder="Add an action item and press Enter"
            onKeyDown={(e) => {
              if (e.key === "Enter" && actionInput.trim()) {
                e.preventDefault();
                setF("action_items", [...(form.action_items ?? []), actionInput.trim()]);
                setActionInput("");
              }
            }}
            className="flex-1 rounded border border-border bg-background px-2 py-1.5 text-sm" />
        </div>
        {form.action_items && form.action_items.length > 0 && (
          <ul className="mt-2 space-y-1 text-sm">
            {form.action_items.map((a, i) => (
              <li key={i} className="flex items-center justify-between rounded bg-muted/40 px-2 py-1">
                <span>{a}</span>
                <button type="button"
                  onClick={() => setF("action_items",
                    (form.action_items ?? []).filter((_, j) => j !== i),
                  )}
                  className="text-xs text-muted-foreground">
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {m.error instanceof Error && (
        <div className="text-sm text-rose-400">{m.error.message}</div>
      )}

      <div className="flex justify-between gap-2">
        <div>
          {review && review.status !== "finalised" && (
            <button type="button" disabled={finalise.isPending}
              onClick={() => finalise.mutate()}
              className="rounded border border-emerald-500/40 px-4 py-2 text-sm text-emerald-300 disabled:opacity-50">
              {finalise.isPending ? "Finalising…" : "Finalise (chair sign-off)"}
            </button>
          )}
          {review?.status === "finalised" && (
            <span className="text-sm text-emerald-400">
              ✓ Finalised on {review.finalised_at && new Date(review.finalised_at).toLocaleDateString()}
            </span>
          )}
        </div>
        <button type="button" disabled={m.isPending} onClick={() => m.mutate()}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {m.isPending ? "Saving…" : review ? "Update review" : "Save review"}
        </button>
      </div>
    </div>
  );
}

// ── Shared ───────────────────────────────────────────────────────────

function KpiCard({
  label, value, tone,
}: { label: string; value: number; tone?: "warning" }) {
  return (
    <div className={`rounded-lg border p-4 ${
      tone === "warning"
        ? "border-amber-500/30 bg-amber-500/5"
        : "border-border bg-card"
    }`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">{label}</div>
      <div className="grid grid-cols-2 gap-3">{children}</div>
    </div>
  );
}

function Field2({
  label, v, on, type = "text", placeholder, multiline,
}: {
  label: string;
  v: string;
  on: (v: string) => void;
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
        <textarea rows={2} value={v} onChange={(e) => on(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      ) : (
        <input type={type} value={v} onChange={(e) => on(e.target.value)}
          placeholder={placeholder}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      )}
    </div>
  );
}

function SelectF({
  label, v, on, options,
}: {
  label: string;
  v: string;
  on: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      <select value={v} onChange={(e) => on(e.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm">
        {options.map(([k, label]) => (
          <option key={k} value={k}>{label}</option>
        ))}
      </select>
    </div>
  );
}

function Check({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm col-span-2">
      <input type="checkbox" checked={v} onChange={(e) => on(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}
