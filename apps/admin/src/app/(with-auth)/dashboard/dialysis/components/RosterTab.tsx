// src/app/(with-auth)/dashboard/dialysis/components/RosterTab.tsx

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
import { DialysisPatient, PatientDetail, unwrap, unwrapList } from "./types";

export default function RosterTab() {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<number | null>(null);
  const [showEnrol, setShowEnrol] = useState(false);

  const { data: list = [], isLoading } = useQuery<DialysisPatient[]>({
    queryKey: ["dialysis", "patients"],
    queryFn: async () => unwrapList<DialysisPatient>(
      await fetchAdminAPI<unknown>(`/dialysis/patients?status=active&limit=300`),
    ),
    refetchInterval: 60_000,
  });

  const { data: detail } = useQuery<PatientDetail>({
    queryKey: ["dialysis", "patient", selected],
    queryFn: async () => unwrap<PatientDetail>(
      await fetchAdminAPI<unknown>(`/dialysis/patients/${selected}`),
    ),
    enabled: selected != null,
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowEnrol(true)}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
        >
          + Enrol patient
        </button>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && list.length === 0 && (
        <EmptyState title="No active dialysis patients enrolled." />
      )}

      {list.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Patient</th>
                <th className="text-left p-3">Modality / Schedule</th>
                <th className="text-left p-3">Dry weight</th>
                <th className="text-left p-3">Anticoag</th>
                <th className="text-left p-3">Serology</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr
                  key={p.id}
                  className={`border-t border-border ${p.isolation_required ? "bg-rose-500/5" : ""}`}
                >
                  <td className="p-3 font-mono text-xs">
                    #{p.id} · {p.patient_uid.slice(0, 8)}…
                    {p.isolation_required && (
                      <span className="ml-2 rounded bg-rose-500/20 text-rose-300 text-[10px] px-1.5 py-0.5">
                        ISOLATION
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-xs">
                    <div className="uppercase">{p.modality}</div>
                    <div className="text-muted-foreground">
                      {p.schedule_pattern ?? "—"}
                      {p.prescribed_minutes && ` · ${p.prescribed_minutes} min`}
                    </div>
                  </td>
                  <td className="p-3 text-xs">
                    {p.dry_weight_kg ? `${p.dry_weight_kg} kg` : "—"}
                  </td>
                  <td className="p-3 text-xs">{p.anticoag_default}</td>
                  <td className="p-3 text-xs space-y-0.5">
                    <div>HBsAg: <SerologyChip v={p.hbsag_status} /></div>
                    <div>HCV: <SerologyChip v={p.hcv_status} /></div>
                    <div>HIV: <SerologyChip v={p.hiv_status} /></div>
                  </td>
                  <td className="p-3 text-right">
                    <button type="button" onClick={() => setSelected(p.id)}
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

      {showEnrol && (
        <EnrolModal
          onClose={() => setShowEnrol(false)}
          onEnrolled={(id) => {
            qc.invalidateQueries({ queryKey: ["dialysis"] });
            setShowEnrol(false);
            setSelected(id);
          }}
        />
      )}

      {selected && detail && (
        <PatientDetailModal
          detail={detail}
          onClose={() => setSelected(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ["dialysis"] })}
        />
      )}
    </div>
  );
}

function SerologyChip({ v }: { v: string }) {
  const tone =
    v === "positive" ? "bg-rose-500/20 text-rose-300"
    : v === "pending" ? "bg-amber-500/15 text-amber-300"
    : "bg-emerald-500/15 text-emerald-300";
  return <span className={`px-1.5 py-0.5 rounded text-[10px] ${tone}`}>{v}</span>;
}

function EnrolModal({
  onClose, onEnrolled,
}: { onClose: () => void; onEnrolled: (id: number) => void }) {
  const [form, setForm] = useState({
    patient_uid: "",
    modality: "hd",
    schedule_pattern: "mwf",
    prescribed_minutes: "240",
    prescribed_dialyser: "",
    dry_weight_kg: "",
    anticoag_default: "heparin",
    hbsag_status: "negative",
    hcv_status: "negative",
    hiv_status: "negative",
    notes: "",
  });

  const m = useMutation({
    mutationFn: async () => {
      const r = await fetchAdminAPI<unknown>("/dialysis/patients", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          prescribed_minutes: form.prescribed_minutes ? Number(form.prescribed_minutes) : undefined,
          dry_weight_kg: form.dry_weight_kg ? Number(form.dry_weight_kg) : undefined,
        }),
      });
      return unwrap<{ id: number }>(r);
    },
    onSuccess: (row) => onEnrolled(row.id),
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-xl rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Enrol dialysis patient</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        <Field label="Patient UID *" v={form.patient_uid}
          on={(v) => setForm({ ...form, patient_uid: v })} />

        <div className="grid grid-cols-2 gap-3">
          <SelectF label="Modality" v={form.modality}
            on={(v) => setForm({ ...form, modality: v })}
            options={[["hd", "HD"], ["hdf", "HDF"], ["pd_capd", "PD CAPD"], ["pd_apd", "PD APD"], ["crrt", "CRRT"], ["sled", "SLED"]]} />
          <SelectF label="Schedule" v={form.schedule_pattern}
            on={(v) => setForm({ ...form, schedule_pattern: v })}
            options={[["mwf", "M/W/F"], ["tts", "T/Th/S"], ["daily", "Daily"], ["sos", "SOS"], ["crrt_continuous", "CRRT continuous"]]} />
          <Field label="Prescribed minutes" v={form.prescribed_minutes} type="number"
            on={(v) => setForm({ ...form, prescribed_minutes: v })} />
          <Field label="Dry weight (kg)" v={form.dry_weight_kg} type="number"
            on={(v) => setForm({ ...form, dry_weight_kg: v })} />
          <Field label="Dialyser" v={form.prescribed_dialyser}
            on={(v) => setForm({ ...form, prescribed_dialyser: v })} />
          <SelectF label="Anti-coag" v={form.anticoag_default}
            on={(v) => setForm({ ...form, anticoag_default: v })}
            options={[["heparin", "Heparin"], ["lmwh", "LMWH"], ["citrate", "Citrate"], ["argatroban", "Argatroban"], ["none", "None"]]} />
        </div>

        <div className="grid grid-cols-3 gap-2">
          <SelectF label="HBsAg" v={form.hbsag_status}
            on={(v) => setForm({ ...form, hbsag_status: v })}
            options={[["negative", "Neg"], ["positive", "POS"], ["pending", "Pending"], ["unknown", "Unknown"]]} />
          <SelectF label="HCV" v={form.hcv_status}
            on={(v) => setForm({ ...form, hcv_status: v })}
            options={[["negative", "Neg"], ["positive", "POS"], ["pending", "Pending"], ["unknown", "Unknown"]]} />
          <SelectF label="HIV" v={form.hiv_status}
            on={(v) => setForm({ ...form, hiv_status: v })}
            options={[["negative", "Neg"], ["positive", "POS"], ["pending", "Pending"], ["unknown", "Unknown"]]} />
        </div>

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={!form.patient_uid.trim() || m.isPending}
            onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Enrolling…" : "Enrol"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PatientDetailModal({
  detail, onClose, onChanged,
}: {
  detail: PatientDetail;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const [showAddAccess, setShowAddAccess] = useState(false);
  const [showSerology, setShowSerology] = useState(false);
  const [newDryWt, setNewDryWt] = useState(detail.dry_weight_kg ?? "");

  const updDryWt = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/dialysis/patients/${detail.id}/dry-weight`,
      { method: "PATCH", body: JSON.stringify({ dry_weight_kg: Number(newDryWt) }) },
    ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dialysis"] });
      onChanged();
    },
  });

  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-3xl rounded-lg border border-border bg-card p-6 space-y-4 my-8">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Patient #{detail.id}</h2>
            <div className="text-xs text-muted-foreground">
              {detail.patient_uid.slice(0, 16)}… · {detail.modality.toUpperCase()}
              {detail.isolation_required && (
                <span className="ml-2 rounded bg-rose-500/20 text-rose-300 px-1.5 py-0.5">
                  ISOLATION REQUIRED
                </span>
              )}
            </div>
          </div>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>

        {/* Dry weight + adequacy */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="rounded-lg border border-border p-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Dry weight</div>
            <div className="flex items-center gap-2 mt-1">
              <input type="number" step="0.1" value={newDryWt}
                onChange={(e) => setNewDryWt(e.target.value)}
                className="w-24 rounded border border-border bg-background px-2 py-1 text-sm" />
              <span className="text-sm">kg</span>
              <button type="button" disabled={updDryWt.isPending || !newDryWt}
                onClick={() => updDryWt.mutate()}
                className="ml-auto rounded bg-primary/20 px-3 py-1 text-xs disabled:opacity-50">
                Update
              </button>
            </div>
            {detail.dry_weight_set_at && (
              <div className="text-xs text-muted-foreground mt-1">
                Last set: {new Date(detail.dry_weight_set_at).toLocaleDateString()}
              </div>
            )}
          </div>
          <div className="rounded-lg border border-border p-3">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Adequacy (30d)</div>
            {detail.adequacy_30d ? (
              <div className="text-sm mt-1 space-y-0.5">
                <div>
                  Mean Kt/V: <span className={
                    Number(detail.adequacy_30d.mean_ktv) >= 1.2 ? "text-emerald-300" : "text-amber-300"
                  }>
                    {detail.adequacy_30d.mean_ktv ?? "—"}
                  </span>
                </div>
                <div>Mean URR: {detail.adequacy_30d.mean_urr_pct ?? "—"} %</div>
                <div className="text-xs text-muted-foreground">
                  {detail.adequacy_30d.sessions_30d} sessions ·
                  {" "}{detail.adequacy_30d.hypotension_episodes} hypoT ·
                  {" "}{detail.adequacy_30d.early_terms} early term
                </div>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground mt-1">Not enough data yet.</div>
            )}
          </div>
        </div>

        {/* Vascular access */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-muted/40">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Vascular access</div>
            <button type="button" onClick={() => setShowAddAccess(true)}
              className="text-xs underline">
              + Add new access
            </button>
          </div>
          {detail.access.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No access on file.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left p-2">Type</th>
                  <th className="text-left p-2">Side</th>
                  <th className="text-left p-2">Created</th>
                  <th className="text-left p-2">QA flow</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {detail.access.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="p-2">{a.access_type.replace(/_/g, " ")}</td>
                    <td className="p-2 text-xs">{a.side ?? "—"}</td>
                    <td className="p-2 text-xs">{a.created_date}</td>
                    <td className={`p-2 text-xs ${
                      a.qa_flow_ml_min != null && a.qa_flow_ml_min < 600 ? "text-amber-300" : ""
                    }`}>
                      {a.qa_flow_ml_min ? `${a.qa_flow_ml_min} mL/min` : "—"}
                    </td>
                    <td className="p-2 text-xs">
                      {a.active
                        ? <span className="text-emerald-400">Active</span>
                        : (
                          <span className="text-muted-foreground">
                            Abandoned {a.abandoned_date} · {a.abandoned_reason ?? ""}
                          </span>
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Serology surveillance */}
        <div className="rounded-lg border border-border overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 bg-muted/40">
            <div className="text-xs uppercase tracking-wider text-muted-foreground">Serology surveillance</div>
            <button type="button" onClick={() => setShowSerology(true)}
              className="text-xs underline">
              + Record result
            </button>
          </div>
          {detail.serology.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">No serology on file.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="text-left p-2">Date</th>
                  <th className="text-left p-2">HBsAg</th>
                  <th className="text-left p-2">HCV</th>
                  <th className="text-left p-2">HIV</th>
                  <th className="text-left p-2">Flag</th>
                </tr>
              </thead>
              <tbody>
                {detail.serology.map((s) => (
                  <tr key={s.id} className={`border-t border-border ${s.is_seroconversion ? "bg-rose-500/10" : ""}`}>
                    <td className="p-2">{s.test_date}</td>
                    <td className="p-2">{s.hbsag ?? "—"}</td>
                    <td className="p-2">{s.anti_hcv ?? "—"}</td>
                    <td className="p-2">{s.hiv ?? "—"}</td>
                    <td className="p-2 text-xs">
                      {s.is_seroconversion && (
                        <span className="text-rose-300 font-semibold">SEROCONV</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {showAddAccess && (
          <AddAccessModal
            patientId={detail.id}
            onClose={() => setShowAddAccess(false)}
            onAdded={() => {
              qc.invalidateQueries({ queryKey: ["dialysis"] });
              setShowAddAccess(false);
            }}
          />
        )}

        {showSerology && (
          <SerologyModal
            patientId={detail.id}
            onClose={() => setShowSerology(false)}
            onSaved={() => {
              qc.invalidateQueries({ queryKey: ["dialysis"] });
              setShowSerology(false);
            }}
          />
        )}
      </div>
    </div>
  );
}

function AddAccessModal({
  patientId, onClose, onAdded,
}: { patientId: number; onClose: () => void; onAdded: () => void }) {
  const [form, setForm] = useState({
    access_type: "avf_radiocephalic",
    side: "left",
    created_date: new Date().toISOString().slice(0, 10),
    first_used_date: "",
    qa_flow_ml_min: "",
  });

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/dialysis/patients/${patientId}/access`,
      {
        method: "POST",
        body: JSON.stringify({
          ...form,
          qa_flow_ml_min: form.qa_flow_ml_min ? Number(form.qa_flow_ml_min) : undefined,
          first_used_date: form.first_used_date || undefined,
        }),
      }),
    onSuccess: () => onAdded(),
  });

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/70 p-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Add vascular access</h3>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>
        <p className="text-xs text-muted-foreground">
          Adding a new active access automatically marks the previous one as abandoned.
        </p>

        <SelectF label="Access type" v={form.access_type}
          on={(v) => setForm({ ...form, access_type: v })}
          options={[
            ["avf_radiocephalic", "AVF radiocephalic"],
            ["avf_brachiocephalic", "AVF brachiocephalic"],
            ["avf_brachiobasilic", "AVF brachiobasilic"],
            ["avg_forearm", "AVG forearm"],
            ["avg_upper_arm", "AVG upper arm"],
            ["avg_thigh", "AVG thigh"],
            ["cvc_temporary_ij", "CVC temporary IJ"],
            ["cvc_temporary_femoral", "CVC temporary femoral"],
            ["cvc_tunneled_ij", "CVC tunneled IJ"],
            ["cvc_tunneled_subclavian", "CVC tunneled subclavian"],
            ["pd_catheter", "PD catheter"],
          ]} />

        <SelectF label="Side" v={form.side}
          on={(v) => setForm({ ...form, side: v })}
          options={[["left", "Left"], ["right", "Right"], ["na", "N/A"]]} />

        <Field label="Created date" v={form.created_date} type="date"
          on={(v) => setForm({ ...form, created_date: v })} />
        <Field label="First used date" v={form.first_used_date} type="date"
          on={(v) => setForm({ ...form, first_used_date: v })} />
        <Field label="QA flow (mL/min)" v={form.qa_flow_ml_min} type="number"
          on={(v) => setForm({ ...form, qa_flow_ml_min: v })} />

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={m.isPending} onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Adding…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SerologyModal({
  patientId, onClose, onSaved,
}: { patientId: number; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    test_date: new Date().toISOString().slice(0, 10),
    hbsag: "negative",
    hbs_titre: "",
    anti_hcv: "negative",
    hcv_pcr: "",
    hiv: "negative",
    notes: "",
  });

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/dialysis/patients/${patientId}/serology`,
      {
        method: "POST",
        body: JSON.stringify({
          ...form,
          hbs_titre: form.hbs_titre ? Number(form.hbs_titre) : undefined,
        }),
      }),
    onSuccess: () => onSaved(),
  });

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/70 p-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-3 my-8">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Record serology result</h3>
          <button type="button" className="text-muted-foreground" onClick={onClose}>✕</button>
        </div>
        <p className="text-xs text-muted-foreground">
          Sero-conversion (negative → positive) auto-flags the patient
          for isolation room.
        </p>

        <Field label="Test date" v={form.test_date} type="date"
          on={(v) => setForm({ ...form, test_date: v })} />

        <div className="grid grid-cols-2 gap-2">
          <SelectF label="HBsAg" v={form.hbsag}
            on={(v) => setForm({ ...form, hbsag: v })}
            options={[["negative", "Neg"], ["positive", "POS"], ["reactive", "Reactive"], ["pending", "Pending"]]} />
          <Field label="HBs titre (IU/L)" v={form.hbs_titre} type="number"
            on={(v) => setForm({ ...form, hbs_titre: v })} />
          <SelectF label="Anti-HCV" v={form.anti_hcv}
            on={(v) => setForm({ ...form, anti_hcv: v })}
            options={[["negative", "Neg"], ["positive", "POS"], ["reactive", "Reactive"], ["pending", "Pending"]]} />
          <Field label="HCV PCR" v={form.hcv_pcr}
            on={(v) => setForm({ ...form, hcv_pcr: v })} />
          <SelectF label="HIV" v={form.hiv}
            on={(v) => setForm({ ...form, hiv: v })}
            options={[["negative", "Neg"], ["positive", "POS"], ["reactive", "Reactive"], ["pending", "Pending"]]} />
        </div>

        {m.error instanceof Error && (
          <div className="text-sm text-rose-400">{m.error.message}</div>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
          <button type="button" disabled={m.isPending} onClick={() => m.mutate()}
            className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
            {m.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, v, on, type = "text",
}: { label: string; v: string; on: (v: string) => void; type?: string }) {
  return (
    <div>
      <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
        {label}
      </label>
      <input type={type} value={v} onChange={(e) => on(e.target.value)}
        className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
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
