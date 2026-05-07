// src/app/(with-auth)/dashboard/icu/components/AssessmentsTab.tsx

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
import { IcuAssessment, fmtDateTime, unwrapList } from "./types";

const RASS_LABELS: Record<number, string> = {
  4: "+4 Combative",
  3: "+3 Very agitated",
  2: "+2 Agitated",
  1: "+1 Restless",
  0: " 0 Alert / calm",
  [-1]: "-1 Drowsy",
  [-2]: "-2 Light sedation",
  [-3]: "-3 Moderate sedation",
  [-4]: "-4 Deep sedation",
  [-5]: "-5 Unarousable",
};

export default function AssessmentsTab({ admissionId }: { admissionId: number }) {
  const qc = useQueryClient();
  const [showRass, setShowRass] = useState(false);
  const [showCam, setShowCam] = useState(false);
  const [showSofa, setShowSofa] = useState(false);
  const [showCpot, setShowCpot] = useState(false);
  const [filter, setFilter] = useState<string>("");

  const { data: list = [], isLoading } = useQuery<IcuAssessment[]>({
    queryKey: ["icu", "assessments", admissionId, filter],
    queryFn: async () => {
      const q = filter ? `?kind=${filter}` : "";
      const r = await fetchAdminAPI<unknown>(
        `/icu/admissions/${admissionId}/assessments${q}`,
      );
      return unwrapList<IcuAssessment>(r);
    },
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground">Kind:</label>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm"
          >
            <option value="">All</option>
            <option value="rass">RASS</option>
            <option value="cam_icu">CAM-ICU</option>
            <option value="sofa">SOFA</option>
            <option value="cpot">CPOT</option>
          </select>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button type="button" onClick={() => setShowRass(true)}
            className="rounded bg-primary/15 px-3 py-1.5 text-sm hover:bg-primary/25">
            + RASS
          </button>
          <button type="button" onClick={() => setShowCam(true)}
            className="rounded bg-primary/15 px-3 py-1.5 text-sm hover:bg-primary/25">
            + CAM-ICU
          </button>
          <button type="button" onClick={() => setShowSofa(true)}
            className="rounded bg-primary/15 px-3 py-1.5 text-sm hover:bg-primary/25">
            + SOFA
          </button>
          <button type="button" onClick={() => setShowCpot(true)}
            className="rounded bg-primary/15 px-3 py-1.5 text-sm hover:bg-primary/25">
            + CPOT
          </button>
        </div>
      </div>

      {isLoading && <LoadingSpinner />}
      {!isLoading && list.length === 0 && (
        <EmptyState title="No assessments yet for this admission." />
      )}

      {list.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="text-left p-3">Time</th>
                <th className="text-left p-3">Kind</th>
                <th className="text-left p-3">Result</th>
                <th className="text-left p-3">Note</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.id} className="border-t border-border">
                  <td className="p-3 whitespace-nowrap">{fmtDateTime(a.recorded_at)}</td>
                  <td className="p-3 uppercase text-xs">{a.assessment_kind.replace("_", "-")}</td>
                  <td className="p-3">
                    {a.assessment_kind === "rass" && (
                      <span>
                        {RASS_LABELS[a.rass_score ?? 0] ?? a.rass_score}
                        {a.rass_target != null && (
                          <span className="text-muted-foreground"> (target: {a.rass_target})</span>
                        )}
                      </span>
                    )}
                    {a.assessment_kind === "cam_icu" && (
                      <span
                        className={
                          a.cam_positive
                            ? "text-rose-300 font-semibold"
                            : "text-emerald-300"
                        }
                      >
                        {a.cam_positive ? "POSITIVE — delirium" : "Negative"}
                      </span>
                    )}
                    {a.assessment_kind === "sofa" && (
                      <span>
                        Total: <strong>{a.sofa_total ?? "—"}</strong>
                        <span className="text-xs text-muted-foreground ml-2">
                          (R{a.sofa_resp ?? 0} C{a.sofa_coag ?? 0} L{a.sofa_liver ?? 0}
                          {" "}Ca{a.sofa_cardio ?? 0} N{a.sofa_cns ?? 0} Re{a.sofa_renal ?? 0})
                        </span>
                      </span>
                    )}
                    {a.assessment_kind === "cpot" && (
                      <span
                        className={
                          (a.cpot_total ?? 0) >= 3 ? "text-amber-300 font-semibold" : ""
                        }
                      >
                        Total: <strong>{a.cpot_total ?? 0}</strong> / 8
                        {(a.cpot_total ?? 0) >= 3 && " — pain"}
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-xs text-muted-foreground">
                    {a.notes ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showRass && (
        <RassModal
          admissionId={admissionId}
          onClose={() => setShowRass(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["icu", "assessments"] });
            setShowRass(false);
          }}
        />
      )}
      {showCam && (
        <CamModal
          admissionId={admissionId}
          onClose={() => setShowCam(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["icu", "assessments"] });
            setShowCam(false);
          }}
        />
      )}
      {showSofa && (
        <SofaModal
          admissionId={admissionId}
          onClose={() => setShowSofa(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["icu", "assessments"] });
            setShowSofa(false);
          }}
        />
      )}
      {showCpot && (
        <CpotModal
          admissionId={admissionId}
          onClose={() => setShowCpot(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["icu", "assessments"] });
            setShowCpot(false);
          }}
        />
      )}
    </div>
  );
}

function ModalShell({
  title, onClose, children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-30 flex items-start justify-center bg-black/60 p-6 overflow-y-auto">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 space-y-4 my-8">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" className="text-muted-foreground" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function RassModal({ admissionId, onClose, onSaved }: {
  admissionId: number; onClose: () => void; onSaved: () => void;
}) {
  const [score, setScore] = useState(0);
  const [target, setTarget] = useState<string>("");
  const [notes, setNotes] = useState("");

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/icu/admissions/${admissionId}/assessments`,
      {
        method: "POST",
        body: JSON.stringify({
          assessment_kind: "rass",
          rass_score: score,
          rass_target: target ? Number(target) : undefined,
          notes: notes || undefined,
        }),
      }),
    onSuccess: () => onSaved(),
  });

  return (
    <ModalShell title="RASS — Sedation/Agitation" onClose={onClose}>
      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Score (−5 unarousable → +4 combative)
        </label>
        <select
          value={score}
          onChange={(e) => setScore(Number(e.target.value))}
          className="w-full rounded border border-border bg-background px-2 py-2 text-sm"
        >
          {[4, 3, 2, 1, 0, -1, -2, -3, -4, -5].map((n) => (
            <option key={n} value={n}>{RASS_LABELS[n]}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Physician target (optional)
        </label>
        <input type="number" value={target} onChange={(e) => setTarget(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      </div>
      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
          Notes
        </label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      </div>
      {m.error instanceof Error && (
        <div className="text-sm text-rose-400">{m.error.message}</div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => m.mutate()} disabled={m.isPending}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {m.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function CamModal({ admissionId, onClose, onSaved }: {
  admissionId: number; onClose: () => void; onSaved: () => void;
}) {
  const [f1, setF1] = useState(false);
  const [f2, setF2] = useState(false);
  const [f3, setF3] = useState(false);
  const [f4, setF4] = useState(false);
  const [notes, setNotes] = useState("");

  const positive = f1 && f2 && (f3 || f4);

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/icu/admissions/${admissionId}/assessments`,
      {
        method: "POST",
        body: JSON.stringify({
          assessment_kind: "cam_icu",
          cam_feature_1: f1, cam_feature_2: f2,
          cam_feature_3: f3, cam_feature_4: f4,
          notes: notes || undefined,
        }),
      }),
    onSuccess: () => onSaved(),
  });

  return (
    <ModalShell title="CAM-ICU — Delirium screen" onClose={onClose}>
      <p className="text-xs text-muted-foreground">
        Positive iff Feature 1 AND Feature 2 AND (Feature 3 OR Feature 4).
      </p>
      <Check label="1. Acute change in mental status OR fluctuating course" v={f1} on={setF1} />
      <Check label="2. Inattention" v={f2} on={setF2} />
      <Check label="3. Altered level of consciousness (RASS ≠ 0)" v={f3} on={setF3} />
      <Check label="4. Disorganized thinking" v={f4} on={setF4} />
      <div
        className={`rounded p-3 text-sm font-semibold text-center ${
          positive ? "bg-rose-500/20 text-rose-200" : "bg-emerald-500/15 text-emerald-300"
        }`}
      >
        Result: {positive ? "POSITIVE" : "Negative"}
      </div>
      <div>
        <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">Notes</label>
        <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm" />
      </div>
      {m.error instanceof Error && (
        <div className="text-sm text-rose-400">{m.error.message}</div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => m.mutate()} disabled={m.isPending}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {m.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function SofaModal({ admissionId, onClose, onSaved }: {
  admissionId: number; onClose: () => void; onSaved: () => void;
}) {
  const [c, setC] = useState({
    sofa_resp: 0, sofa_coag: 0, sofa_liver: 0,
    sofa_cardio: 0, sofa_cns: 0, sofa_renal: 0,
  });
  const total = Object.values(c).reduce((a, b) => a + b, 0);

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/icu/admissions/${admissionId}/assessments`,
      {
        method: "POST",
        body: JSON.stringify({ assessment_kind: "sofa", ...c }),
      }),
    onSuccess: () => onSaved(),
  });

  const fields: Array<[keyof typeof c, string]> = [
    ["sofa_resp", "Respiratory (PaO₂/FiO₂)"],
    ["sofa_coag", "Coagulation (Platelets)"],
    ["sofa_liver", "Liver (Bilirubin)"],
    ["sofa_cardio", "Cardiovascular (MAP / pressors)"],
    ["sofa_cns", "CNS (GCS)"],
    ["sofa_renal", "Renal (Creatinine / urine)"],
  ];

  return (
    <ModalShell title="SOFA — Organ failure" onClose={onClose}>
      <p className="text-xs text-muted-foreground">Each component 0 (no failure) → 4 (severe).</p>
      {fields.map(([k, label]) => (
        <div key={k}>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            {label}
          </label>
          <div className="flex gap-1">
            {[0, 1, 2, 3, 4].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setC({ ...c, [k]: n })}
                className={`flex-1 py-1 text-sm rounded ${
                  c[k] === n
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="text-center text-lg font-semibold">
        SOFA total: <span className={total >= 10 ? "text-rose-300" : ""}>{total}</span> / 24
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => m.mutate()} disabled={m.isPending}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {m.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function CpotModal({ admissionId, onClose, onSaved }: {
  admissionId: number; onClose: () => void; onSaved: () => void;
}) {
  const [c, setC] = useState({
    cpot_facial: 0, cpot_movement: 0,
    cpot_muscle_tension: 0, cpot_vent_compliance: 0,
  });
  const total = Object.values(c).reduce((a, b) => a + b, 0);

  const m = useMutation({
    mutationFn: async () => fetchAdminAPI<unknown>(
      `/icu/admissions/${admissionId}/assessments`,
      {
        method: "POST",
        body: JSON.stringify({ assessment_kind: "cpot", ...c }),
      }),
    onSuccess: () => onSaved(),
  });

  const fields: Array<[keyof typeof c, string]> = [
    ["cpot_facial", "Facial expression"],
    ["cpot_movement", "Body movements"],
    ["cpot_muscle_tension", "Muscle tension"],
    ["cpot_vent_compliance", "Vent compliance / vocalization"],
  ];

  return (
    <ModalShell title="CPOT — Pain in non-verbal" onClose={onClose}>
      <p className="text-xs text-muted-foreground">Each 0 → 2; total ≥3 = pain.</p>
      {fields.map(([k, label]) => (
        <div key={k}>
          <label className="block text-xs uppercase tracking-wider text-muted-foreground mb-1">
            {label}
          </label>
          <div className="flex gap-1">
            {[0, 1, 2].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setC({ ...c, [k]: n })}
                className={`flex-1 py-1 text-sm rounded ${
                  c[k] === n
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
      ))}
      <div className="text-center text-lg font-semibold">
        CPOT total: <span className={total >= 3 ? "text-amber-300" : ""}>{total}</span> / 8
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
        <button type="button" onClick={() => m.mutate()} disabled={m.isPending}
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
          {m.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </ModalShell>
  );
}

function Check({ label, v, on }: { label: string; v: boolean; on: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={v}
        onChange={(e) => on(e.target.checked)}
        className="mt-0.5"
      />
      <span>{label}</span>
    </label>
  );
}
