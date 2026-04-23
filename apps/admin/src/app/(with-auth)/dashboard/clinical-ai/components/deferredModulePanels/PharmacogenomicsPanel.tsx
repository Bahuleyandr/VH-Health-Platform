"use client";

// Phase-2 clinical-AI panel. Tracker row 18 — pharmacogenomics_support.
// Two-tier module:
//   Top tier  — patient genotypes (list + upsert form)
//   Bottom    — PGx advisories (evaluate + list + decide via the shared queue)
//
// Backend routes (apps/backend/src/routes/admin/clinicalAiRoutes.js):
//   POST  /admin/clinical-ai/pgx/genotypes          upsertPatientGenotype
//   GET   /admin/clinical-ai/pgx/genotypes          listPatientGenotypes
//   POST  /admin/clinical-ai/pgx/advisories/evaluate generatePgxAdvisory
//   GET   /admin/clinical-ai/pgx/advisories         listPgxAdvisories
//   PATCH /admin/clinical-ai/pgx/advisories/:id     decidePgxAdvisory

import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Dna, PlayCircle, Save } from "lucide-react";
import { toast } from "react-hot-toast";

import {
  ClinicalAIReviewQueue,
  fmt,
  readableKey,
  severityBadgeClass,
  type ColumnSpec,
  type DecideAction,
  type FilterSpec,
} from "../ClinicalAIReviewQueue";
import {
  decideClinicalAi,
  evaluateClinicalAi,
  listClinicalAi,
} from "@/lib/api/clinicalAiGeneric";

// ---------------------------------------------------------------------------
// Reference data (mirrors SUPPORTED_GENES / SUPPORTED_PHENOTYPES in
// apps/backend/src/services/ai/pharmacogenomicsService.js).
// ---------------------------------------------------------------------------
const GENES = [
  "CYP2D6",
  "CYP2C19",
  "CYP2C9",
  "VKORC1",
  "SLCO1B1",
  "HLA_B_5701",
  "HLA_B_1502",
  "TPMT",
  "DPYD",
  "UGT1A1",
  "G6PD",
] as const;

const PHENOTYPES = [
  "poor_metabolizer",
  "intermediate_metabolizer",
  "normal_metabolizer",
  "rapid_metabolizer",
  "ultra_rapid_metabolizer",
  "positive",
  "negative",
  "deficient",
  "unknown",
] as const;

type PgxDecision = "accepted" | "deferred" | "rejected" | "edited";

type PatientGenotype = {
  id: number;
  patient_uid: string;
  gene: string;
  phenotype: string;
  genotype_detail: string | null;
  source: string | null;
  source_report_id: string | null;
  tested_at: string | null;
  verified: boolean;
  created_at: string | null;
  updated_at: string | null;
};

type PgxAdvisoryRow = {
  id: number;
  patient_uid: string;
  patient_name: string | null;
  medication_name: string;
  matched_genes: string[] | null;
  advisory_category: string;
  severity: string;
  summary: string | null;
  reviewer_decision: string;
  reviewed_at: string | null;
  created_at: string | null;
};

const ADVISORY_CATEGORY_OPTIONS = [
  { value: "no_action", label: "No action" },
  { value: "standard_dose", label: "Standard dose" },
  { value: "consider_dose_change", label: "Consider dose change" },
  { value: "use_alternative", label: "Use alternative" },
  { value: "contraindicated", label: "Contraindicated" },
  { value: "testing_recommended", label: "Testing recommended" },
  { value: "unknown", label: "Unknown" },
];

const SEVERITY_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "moderate", label: "Moderate" },
  { value: "low", label: "Low" },
  { value: "unknown", label: "Unknown" },
];

const DECISION_FILTER_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "accepted", label: "Accepted" },
  { value: "deferred", label: "Deferred" },
  { value: "rejected", label: "Rejected" },
  { value: "edited", label: "Edited" },
];

const ADVISORY_FILTERS: FilterSpec[] = [
  { key: "patient_uid", label: "Patient UID", kind: "text", placeholder: "patient uid" },
  {
    key: "advisory_category",
    label: "Category",
    kind: "select",
    options: ADVISORY_CATEGORY_OPTIONS,
  },
  { key: "severity", label: "Severity", kind: "select", options: SEVERITY_OPTIONS },
  {
    key: "reviewer_decision",
    label: "Review",
    kind: "select",
    options: DECISION_FILTER_OPTIONS,
  },
];

const ADVISORY_DECIDE_ACTIONS: DecideAction<PgxDecision>[] = [
  { value: "accepted", label: "Accept", variant: "success" },
  { value: "deferred", label: "Defer", variant: "warning", promptForNote: true },
  { value: "rejected", label: "Reject", variant: "danger", promptForNote: true },
  { value: "edited", label: "Mark edited", variant: "muted", promptForNote: true },
];

const ADVISORY_COLUMNS: ColumnSpec<PgxAdvisoryRow>[] = [
  {
    key: "patient",
    header: "Patient",
    render: (row) => (
      <div>
        <div className="font-medium">{row.patient_name ?? "-"}</div>
        <div className="font-mono text-xs text-muted-foreground">
          {row.patient_uid}
        </div>
      </div>
    ),
  },
  {
    key: "medication",
    header: "Medication",
    render: (row) => (
      <div>
        <div className="font-medium">{row.medication_name}</div>
        <div className="text-xs text-muted-foreground">
          {(row.matched_genes ?? []).join(", ") || "-"}
        </div>
      </div>
    ),
  },
  {
    key: "severity",
    header: "Severity",
    render: (row) => (
      <span
        className={`rounded-full border px-2 py-0.5 text-xs font-medium ${severityBadgeClass(row.severity)}`}
      >
        {row.severity || "unknown"}
      </span>
    ),
  },
  {
    key: "category",
    header: "Category",
    render: (row) => (
      <div>
        <div>{readableKey(row.advisory_category)}</div>
        {row.summary ? (
          <div className="text-xs text-muted-foreground">{row.summary}</div>
        ) : null}
      </div>
    ),
  },
  {
    key: "created_at",
    header: "Created",
    render: (row) => (
      <span className="text-xs text-muted-foreground">{fmt(row.created_at)}</span>
    ),
  },
];

const GENOTYPES_PATH = "/admin/clinical-ai/pgx/genotypes";
const ADVISORIES_PATH = "/admin/clinical-ai/pgx/advisories";
const ADVISORIES_EVALUATE_PATH = `${ADVISORIES_PATH}/evaluate`;

// ---------------------------------------------------------------------------
// Top tier — patient genotypes + upsert form.
// ---------------------------------------------------------------------------
type GenotypeUpsertPayload = {
  patient_uid: string;
  gene: string;
  phenotype: string;
  genotype_detail?: string | null;
  source?: string | null;
  source_report_id?: string | null;
  tested_at?: string | null;
  verified?: boolean;
};

type GenotypeListResult = {
  genotypes?: PatientGenotype[];
  count?: number;
};

function PatientGenotypesSection({
  patientUid,
  onPatientUidChange,
}: {
  patientUid: string;
  onPatientUidChange: (value: string) => void;
}) {
  const queryClient = useQueryClient();
  const trimmedUid = patientUid.trim();

  const genotypes = useQuery({
    queryKey: ["clinical-ai", "pharmacogenomics_support", "genotypes", trimmedUid],
    // Only fire when a patient_uid is supplied — the endpoint requires it.
    enabled: trimmedUid.length > 0,
    queryFn: () =>
      listClinicalAi(GENOTYPES_PATH, { patient_uid: trimmedUid }) as Promise<
        GenotypeListResult & { count: number }
      >,
  });

  const [gene, setGene] = useState<string>(GENES[0]);
  const [phenotype, setPhenotype] = useState<string>(PHENOTYPES[0]);
  const [genotypeDetail, setGenotypeDetail] = useState("");
  const [source, setSource] = useState("");
  const [sourceReportId, setSourceReportId] = useState("");
  const [testedAt, setTestedAt] = useState("");
  const [verified, setVerified] = useState(false);

  const upsert = useMutation({
    mutationFn: (payload: GenotypeUpsertPayload) =>
      evaluateClinicalAi(GENOTYPES_PATH, payload as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Genotype saved");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "pharmacogenomics_support"],
      });
      setGenotypeDetail("");
      setSource("");
      setSourceReportId("");
      setTestedAt("");
      setVerified(false);
    },
    onError: (err: Error) =>
      toast.error(err.message || "Failed to save genotype"),
  });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedUid) {
      toast.error("Enter a patient UID first");
      return;
    }
    upsert.mutate({
      patient_uid: trimmedUid,
      gene,
      phenotype,
      genotype_detail: genotypeDetail.trim() || null,
      source: source.trim() || null,
      source_report_id: sourceReportId.trim() || null,
      tested_at: testedAt || null,
      verified,
    });
  };

  const rows = genotypes.data?.genotypes ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Dna className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-base font-semibold">Patient Genotypes</h3>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <label className="block space-y-1 text-sm">
          <span className="text-muted-foreground">Patient UID</span>
          <input
            value={patientUid}
            onChange={(event) => onPatientUidChange(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="enter patient UID to load genotypes"
          />
        </label>
      </div>

      {trimmedUid ? (
        <>
          <form
            onSubmit={onSubmit}
            className="rounded-lg border border-border bg-card p-4"
          >
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Gene</span>
                <select
                  value={gene}
                  onChange={(event) => setGene(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                >
                  {GENES.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Phenotype</span>
                <select
                  value={phenotype}
                  onChange={(event) => setPhenotype(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                >
                  {PHENOTYPES.map((value) => (
                    <option key={value} value={value}>
                      {readableKey(value)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Tested at</span>
                <input
                  type="date"
                  value={testedAt}
                  onChange={(event) => setTestedAt(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-muted-foreground">Genotype detail (optional)</span>
                <input
                  value={genotypeDetail}
                  onChange={(event) => setGenotypeDetail(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                  placeholder="e.g. *1/*17"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Source</span>
                <input
                  value={source}
                  onChange={(event) => setSource(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                  placeholder="CPIC, lab, ..."
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-muted-foreground">Source report ID</span>
                <input
                  value={sourceReportId}
                  onChange={(event) => setSourceReportId(event.target.value)}
                  className="w-full rounded-md border border-border bg-background px-3 py-2"
                />
              </label>
              <label className="flex items-center gap-2 pt-6 text-sm">
                <input
                  type="checkbox"
                  checked={verified}
                  onChange={(event) => setVerified(event.target.checked)}
                  className="h-4 w-4"
                />
                <span className="text-muted-foreground">Verified by clinician</span>
              </label>
            </div>
            <div className="mt-3 flex justify-end">
              <button
                type="submit"
                disabled={upsert.isPending}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              >
                <Save className="h-4 w-4" />
                {upsert.isPending ? "Saving…" : "Save genotype"}
              </button>
            </div>
          </form>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Gene</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Phenotype</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Detail</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Source</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Verified</th>
                  <th className="px-4 py-3 text-left font-medium text-muted-foreground">Tested</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {genotypes.isLoading ? (
                  <tr>
                    <td
                      className="px-4 py-8 text-center text-sm text-slate-500"
                      colSpan={6}
                    >
                      Loading…
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td
                      className="px-4 py-8 text-center text-sm text-slate-500"
                      colSpan={6}
                    >
                      No genotypes on file
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-3 font-mono text-xs">{row.gene}</td>
                      <td className="px-4 py-3">{readableKey(row.phenotype)}</td>
                      <td className="px-4 py-3 text-xs">
                        {row.genotype_detail ?? "-"}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        <div>{row.source ?? "-"}</div>
                        {row.source_report_id ? (
                          <div className="font-mono text-muted-foreground">
                            {row.source_report_id}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-xs">
                        {row.verified ? "yes" : "no"}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {fmt(row.tested_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Enter a patient UID to view or record genotypes.
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bottom tier — PGx advisory evaluate form (slot) + list + decide.
// ---------------------------------------------------------------------------
function PgxEvaluateForm() {
  const queryClient = useQueryClient();
  const [patientUid, setPatientUid] = useState("");
  const [medicationName, setMedicationName] = useState("");
  const [prescriptionId, setPrescriptionId] = useState("");

  const evaluate = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        patient_uid: patientUid.trim(),
        medication_name: medicationName.trim(),
      };
      const parsedId = prescriptionId.trim()
        ? Number.parseInt(prescriptionId.trim(), 10)
        : NaN;
      if (Number.isFinite(parsedId)) body.prescription_id = parsedId;
      return evaluateClinicalAi(ADVISORIES_EVALUATE_PATH, body);
    },
    onSuccess: () => {
      toast.success("PGx advisory generated");
      setMedicationName("");
      setPrescriptionId("");
      queryClient.invalidateQueries({
        queryKey: ["clinical-ai", "pharmacogenomics_support"],
      });
    },
    onError: (err: Error) =>
      toast.error(err.message || "PGx evaluation failed"),
  });

  const canSubmit =
    patientUid.trim().length > 0 && medicationName.trim().length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        evaluate.mutate();
      }}
      className="rounded-lg border border-border bg-card p-4"
    >
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto_auto] md:items-end">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Patient UID</span>
          <input
            value={patientUid}
            onChange={(event) => setPatientUid(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Medication name</span>
          <input
            value={medicationName}
            onChange={(event) => setMedicationName(event.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2"
            placeholder="e.g. clopidogrel"
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">Rx ID (optional)</span>
          <input
            value={prescriptionId}
            onChange={(event) => setPrescriptionId(event.target.value)}
            inputMode="numeric"
            className="w-full rounded-md border border-border bg-background px-3 py-2"
          />
        </label>
        <button
          type="submit"
          disabled={evaluate.isPending || !canSubmit}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
        >
          <PlayCircle className="h-4 w-4" />
          {evaluate.isPending ? "Evaluating…" : "Evaluate"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Top-level composite panel.
// ---------------------------------------------------------------------------
export default function PharmacogenomicsPanel() {
  const [patientUid, setPatientUid] = useState("");

  return (
    <section className="space-y-6">
      <div className="flex items-center gap-2">
        <Dna className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-lg font-semibold">Pharmacogenomics Support</h2>
      </div>

      <PatientGenotypesSection
        patientUid={patientUid}
        onPatientUidChange={setPatientUid}
      />

      <ClinicalAIReviewQueue<PgxAdvisoryRow, PgxDecision>
        title="PGx Advisories"
        moduleKey="pharmacogenomics_support"
        icon={<Dna className="h-4 w-4" />}
        description="Gene-drug advisories. Evaluate a prescription to draft a new advisory, then review and decide."
        listFn={(params) => listClinicalAi(ADVISORIES_PATH, params)}
        rowsKey="advisories"
        decideFn={(id, decision, note) =>
          decideClinicalAi(ADVISORIES_PATH, id, decision, note)
        }
        filters={ADVISORY_FILTERS}
        defaultFilters={{ reviewer_decision: "pending" }}
        columns={ADVISORY_COLUMNS}
        decideActions={ADVISORY_DECIDE_ACTIONS}
        evaluateForm={<PgxEvaluateForm />}
        emptyState="No PGx advisories pending review"
      />
    </section>
  );
}
