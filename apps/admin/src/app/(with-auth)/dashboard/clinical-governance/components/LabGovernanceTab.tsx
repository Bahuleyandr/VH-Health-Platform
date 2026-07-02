"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Beaker, CheckCircle2, Microscope, Plus, RefreshCw } from "lucide-react";
import { toast } from "react-hot-toast";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  createLabSpecimen,
  listLabAnalyzers,
  listLabQcRuns,
  listLabSpecimens,
  recordLabQcRun,
  saveLabAnalyzer,
  transitionLabSpecimen,
  type AnalyzerStatus,
  type LabAnalyzer,
  type LabQcRun,
  type LabSpecimen,
  type QcResultStatus,
  type SpecimenStatus,
} from "@/lib/api/clinicalGovernance";
import {
  ANALYZER_STATUSES,
  ErrorBanner,
  fmt,
  Pill,
  QC_STATUSES,
  SectionCard,
  shortUid,
  SPECIMEN_STATUSES,
} from "./shared";

export function LabGovernanceTab() {
  const queryClient = useQueryClient();
  const [specimenFilter, setSpecimenFilter] = useState({ patient_uid: "", status: "" as SpecimenStatus | "" });
  const [specimenDraft, setSpecimenDraft] = useState({
    patient_uid: "",
    accession_number: "",
    specimen_type: "blood",
    priority: "routine",
    container_type: "",
    collection_site: "",
  });
  const [analyzerStatus, setAnalyzerStatus] = useState<AnalyzerStatus | "">("active");
  const [selectedAnalyzerId, setSelectedAnalyzerId] = useState<number | null>(null);
  const [analyzerDraft, setAnalyzerDraft] = useState({
    analyzer_code: "",
    display_name: "",
    manufacturer: "",
    model: "",
    serial_number: "",
    interface_kind: "manual",
    status: "active" as AnalyzerStatus,
  });
  const [qcDraft, setQcDraft] = useState({
    qc_level: "normal",
    qc_lot_number: "",
    result_status: "passed" as QcResultStatus,
    measured_values: "{}",
    notes: "",
  });

  const specimensQuery = useQuery({
    queryKey: ["clinical-governance", "lab-specimens", specimenFilter],
    queryFn: () =>
      listLabSpecimens({
        patient_uid: specimenFilter.patient_uid.trim() || undefined,
        status: specimenFilter.status || undefined,
        limit: 100,
      }),
  });

  const analyzersQuery = useQuery({
    queryKey: ["clinical-governance", "lab-analyzers", analyzerStatus],
    queryFn: () => listLabAnalyzers({ status: analyzerStatus || undefined, limit: 100 }),
  });
  const analyzers = useMemo(() => analyzersQuery.data?.analyzers ?? [], [analyzersQuery.data?.analyzers]);

  useEffect(() => {
    if (analyzers.length === 0) {
      setSelectedAnalyzerId(null);
      return;
    }
    if (selectedAnalyzerId == null || !analyzers.some((analyzer) => analyzer.id === selectedAnalyzerId)) {
      setSelectedAnalyzerId(analyzers[0].id);
    }
  }, [analyzers, selectedAnalyzerId]);

  const selectedAnalyzer = analyzers.find((analyzer) => analyzer.id === selectedAnalyzerId) ?? null;
  const qcQuery = useQuery({
    queryKey: ["clinical-governance", "lab-qc-runs", selectedAnalyzerId],
    queryFn: () => listLabQcRuns(selectedAnalyzerId as number, { limit: 50 }),
    enabled: selectedAnalyzerId != null,
  });

  const createSpecimenMutation = useMutation({
    mutationFn: () =>
      createLabSpecimen({
        patient_uid: specimenDraft.patient_uid.trim(),
        accession_number: specimenDraft.accession_number.trim(),
        specimen_type: specimenDraft.specimen_type.trim() || "blood",
        priority: specimenDraft.priority.trim() || "routine",
        container_type: specimenDraft.container_type.trim() || null,
        collection_site: specimenDraft.collection_site.trim() || null,
      }),
    onSuccess: () => {
      toast.success("Specimen created");
      setSpecimenDraft({
        patient_uid: "",
        accession_number: "",
        specimen_type: "blood",
        priority: "routine",
        container_type: "",
        collection_site: "",
      });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-specimens"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not create specimen"),
  });

  const transitionSpecimenMutation = useMutation({
    mutationFn: ({ specimen, next_status }: { specimen: LabSpecimen; next_status: SpecimenStatus }) =>
      transitionLabSpecimen(specimen.id, {
        next_status,
        reason: `Admin governance transition to ${next_status}`,
      }),
    onSuccess: () => {
      toast.success("Specimen updated");
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-specimens"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not update specimen"),
  });

  const saveAnalyzerMutation = useMutation({
    mutationFn: () =>
      saveLabAnalyzer({
        analyzer_code: analyzerDraft.analyzer_code.trim(),
        display_name: analyzerDraft.display_name.trim(),
        manufacturer: analyzerDraft.manufacturer.trim() || null,
        model: analyzerDraft.model.trim() || null,
        serial_number: analyzerDraft.serial_number.trim() || null,
        interface_kind: analyzerDraft.interface_kind.trim() || "manual",
        status: analyzerDraft.status,
      }),
    onSuccess: (analyzer) => {
      toast.success("Analyzer saved");
      setSelectedAnalyzerId(analyzer.id);
      setAnalyzerDraft({
        analyzer_code: "",
        display_name: "",
        manufacturer: "",
        model: "",
        serial_number: "",
        interface_kind: "manual",
        status: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-analyzers"] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not save analyzer"),
  });

  const recordQcMutation = useMutation({
    mutationFn: () => {
      if (!selectedAnalyzerId) throw new Error("Select an analyzer first");
      let measuredValues: Record<string, unknown> = {};
      const raw = qcDraft.measured_values.trim();
      if (raw) {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Measured values must be a JSON object");
        }
        measuredValues = parsed as Record<string, unknown>;
      }
      return recordLabQcRun(selectedAnalyzerId, {
        qc_level: qcDraft.qc_level,
        qc_lot_number: qcDraft.qc_lot_number.trim() || null,
        result_status: qcDraft.result_status,
        measured_values: measuredValues,
        notes: qcDraft.notes.trim() || null,
      });
    },
    onSuccess: () => {
      toast.success("QC run recorded");
      setQcDraft({ qc_level: "normal", qc_lot_number: "", result_status: "passed", measured_values: "{}", notes: "" });
      queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-qc-runs", selectedAnalyzerId] });
    },
    onError: (error: Error) => toast.error(error.message || "Could not record QC run"),
  });

  const busy =
    createSpecimenMutation.isPending ||
    transitionSpecimenMutation.isPending ||
    saveAnalyzerMutation.isPending ||
    recordQcMutation.isPending;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <SectionCard
        title="Specimen registry"
        icon={Beaker}
        action={
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["clinical-governance", "lab-specimens"] })}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(220px,1fr)_180px]">
            <input
              value={specimenFilter.patient_uid}
              onChange={(event) => setSpecimenFilter((current) => ({ ...current, patient_uid: event.target.value }))}
              placeholder="Filter by patient UID"
              className="rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
            />
            <select
              value={specimenFilter.status}
              onChange={(event) => setSpecimenFilter((current) => ({ ...current, status: event.target.value as SpecimenStatus | "" }))}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">All statuses</option>
              {SPECIMEN_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <ErrorBanner error={specimensQuery.error} />
          <CreateSpecimenForm
            draft={specimenDraft}
            setDraft={setSpecimenDraft}
            busy={busy}
            onSubmit={() => createSpecimenMutation.mutate()}
          />
          <SpecimenTable
            specimens={specimensQuery.data?.specimens ?? []}
            loading={specimensQuery.isLoading}
            busy={busy}
            onTransition={(specimen, next_status) => transitionSpecimenMutation.mutate({ specimen, next_status })}
          />
        </div>
      </SectionCard>

      <SectionCard title="Analyzers and QC" icon={Microscope}>
        <div className="space-y-3">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_170px]">
            <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              Analyzer master, interface type, and QC runs are kept tenant-scoped and auditable.
            </p>
            <select
              value={analyzerStatus}
              onChange={(event) => setAnalyzerStatus(event.target.value as AnalyzerStatus | "")}
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">All analyzers</option>
              {ANALYZER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>
          <ErrorBanner error={analyzersQuery.error ?? qcQuery.error} />
          <AnalyzerForm
            draft={analyzerDraft}
            setDraft={setAnalyzerDraft}
            busy={busy}
            onSubmit={() => saveAnalyzerMutation.mutate()}
          />
          <AnalyzerList
            analyzers={analyzers}
            selectedId={selectedAnalyzerId}
            loading={analyzersQuery.isLoading}
            onSelect={setSelectedAnalyzerId}
          />
          <QcPanel
            analyzer={selectedAnalyzer}
            qcRuns={qcQuery.data?.qc_runs ?? []}
            loading={qcQuery.isLoading}
            draft={qcDraft}
            setDraft={setQcDraft}
            busy={busy}
            onSubmit={() => recordQcMutation.mutate()}
          />
        </div>
      </SectionCard>
    </div>
  );
}

function CreateSpecimenForm({
  draft,
  setDraft,
  busy,
  onSubmit,
}: {
  draft: {
    patient_uid: string;
    accession_number: string;
    specimen_type: string;
    priority: string;
    container_type: string;
    collection_site: string;
  };
  setDraft: (draft: {
    patient_uid: string;
    accession_number: string;
    specimen_type: string;
    priority: string;
    container_type: string;
    collection_site: string;
  }) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-semibold text-muted-foreground">Create specimen</p>
      <div className="grid gap-2 lg:grid-cols-12">
        <input
          value={draft.patient_uid}
          onChange={(event) => setDraft({ ...draft, patient_uid: event.target.value })}
          placeholder="patient_uid"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
        />
        <input
          value={draft.accession_number}
          onChange={(event) => setDraft({ ...draft, accession_number: event.target.value })}
          placeholder="Accession number"
          className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.specimen_type}
          onChange={(event) => setDraft({ ...draft, specimen_type: event.target.value })}
          placeholder="Type"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.priority}
          onChange={(event) => setDraft({ ...draft, priority: event.target.value })}
          placeholder="Priority"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !draft.patient_uid.trim() || !draft.accession_number.trim()}
          className="lg:col-span-1 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
        <input
          value={draft.container_type}
          onChange={(event) => setDraft({ ...draft, container_type: event.target.value })}
          placeholder="Container (optional)"
          className="lg:col-span-6 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.collection_site}
          onChange={(event) => setDraft({ ...draft, collection_site: event.target.value })}
          placeholder="Collection site (optional)"
          className="lg:col-span-6 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
      </div>
    </div>
  );
}

function SpecimenTable({
  specimens,
  loading,
  busy,
  onTransition,
}: {
  specimens: LabSpecimen[];
  loading: boolean;
  busy: boolean;
  onTransition: (specimen: LabSpecimen, nextStatus: SpecimenStatus) => void;
}) {
  if (loading) return <LoadingSpinner label="Loading specimens" />;
  if (specimens.length === 0) {
    return <EmptyState title="No specimens" description="Specimens matching the current filters will appear here." compact />;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full text-xs">
        <thead className="bg-muted/50">
          <tr>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">accession</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">patient</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">type</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">status</th>
            <th className="px-3 py-2 text-left font-medium text-muted-foreground">created</th>
            <th className="px-3 py-2 text-right font-medium text-muted-foreground">transition</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {specimens.map((specimen) => (
            <tr key={specimen.id}>
              <td className="px-3 py-2 font-mono">{specimen.accession_number}</td>
              <td className="px-3 py-2 font-mono">{shortUid(specimen.patient_uid)}</td>
              <td className="px-3 py-2">
                {specimen.specimen_type}
                <span className="ml-1 text-muted-foreground">{specimen.priority}</span>
              </td>
              <td className="px-3 py-2"><Pill value={specimen.status} /></td>
              <td className="px-3 py-2 text-muted-foreground">{fmt(specimen.created_at)}</td>
              <td className="px-3 py-2 text-right">
                <select
                  value={specimen.status}
                  onChange={(event) => onTransition(specimen, event.target.value as SpecimenStatus)}
                  disabled={busy}
                  className="rounded border border-border bg-background px-2 py-1 text-xs"
                >
                  {SPECIMEN_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalyzerForm({
  draft,
  setDraft,
  busy,
  onSubmit,
}: {
  draft: {
    analyzer_code: string;
    display_name: string;
    manufacturer: string;
    model: string;
    serial_number: string;
    interface_kind: string;
    status: AnalyzerStatus;
  };
  setDraft: (draft: {
    analyzer_code: string;
    display_name: string;
    manufacturer: string;
    model: string;
    serial_number: string;
    interface_kind: string;
    status: AnalyzerStatus;
  }) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/20 p-3">
      <p className="mb-2 text-xs font-semibold text-muted-foreground">Add analyzer</p>
      <div className="grid gap-2 lg:grid-cols-12">
        <input
          value={draft.analyzer_code}
          onChange={(event) => setDraft({ ...draft, analyzer_code: event.target.value })}
          placeholder="Code"
          className="lg:col-span-3 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
        />
        <input
          value={draft.display_name}
          onChange={(event) => setDraft({ ...draft, display_name: event.target.value })}
          placeholder="Display name"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.manufacturer}
          onChange={(event) => setDraft({ ...draft, manufacturer: event.target.value })}
          placeholder="Manufacturer"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          placeholder="Model"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !draft.analyzer_code.trim() || !draft.display_name.trim()}
          className="lg:col-span-1 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          Save
        </button>
        <input
          value={draft.serial_number}
          onChange={(event) => setDraft({ ...draft, serial_number: event.target.value })}
          placeholder="Serial number"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.interface_kind}
          onChange={(event) => setDraft({ ...draft, interface_kind: event.target.value })}
          placeholder="Interface kind"
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <select
          value={draft.status}
          onChange={(event) => setDraft({ ...draft, status: event.target.value as AnalyzerStatus })}
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs"
        >
          {ANALYZER_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function AnalyzerList({
  analyzers,
  selectedId,
  loading,
  onSelect,
}: {
  analyzers: LabAnalyzer[];
  selectedId: number | null;
  loading: boolean;
  onSelect: (id: number) => void;
}) {
  if (loading) return <LoadingSpinner label="Loading analyzers" />;
  if (analyzers.length === 0) {
    return <EmptyState title="No analyzers" description="Create an analyzer before recording QC." compact />;
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {analyzers.map((analyzer) => (
        <button
          key={analyzer.id}
          type="button"
          onClick={() => onSelect(analyzer.id)}
          className={`rounded-md border p-3 text-left text-xs ${
            analyzer.id === selectedId ? "border-primary bg-primary/10" : "border-border bg-card hover:bg-muted/30"
          }`}
        >
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">{analyzer.display_name}</p>
              <p className="font-mono text-muted-foreground">{analyzer.analyzer_code}</p>
            </div>
            <Pill value={analyzer.status} />
          </div>
          <p className="mt-1 text-muted-foreground">
            {[analyzer.manufacturer, analyzer.model, analyzer.interface_kind].filter(Boolean).join(" - ") || "No hardware details"}
          </p>
        </button>
      ))}
    </div>
  );
}

function QcPanel({
  analyzer,
  qcRuns,
  loading,
  draft,
  setDraft,
  busy,
  onSubmit,
}: {
  analyzer: LabAnalyzer | null;
  qcRuns: LabQcRun[];
  loading: boolean;
  draft: {
    qc_level: string;
    qc_lot_number: string;
    result_status: QcResultStatus;
    measured_values: string;
    notes: string;
  };
  setDraft: (draft: {
    qc_level: string;
    qc_lot_number: string;
    result_status: QcResultStatus;
    measured_values: string;
    notes: string;
  }) => void;
  busy: boolean;
  onSubmit: () => void;
}) {
  if (!analyzer) {
    return <EmptyState title="Select an analyzer" description="QC recording appears once an analyzer is selected." compact />;
  }
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <p className="text-sm font-semibold">QC for {analyzer.display_name}</p>
        <p className="font-mono text-xs text-muted-foreground">{analyzer.analyzer_code}</p>
      </div>
      <div className="grid gap-2 lg:grid-cols-12">
        <input
          value={draft.qc_level}
          onChange={(event) => setDraft({ ...draft, qc_level: event.target.value })}
          placeholder="qc_level"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <input
          value={draft.qc_lot_number}
          onChange={(event) => setDraft({ ...draft, qc_lot_number: event.target.value })}
          placeholder="Lot"
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
        <select
          value={draft.result_status}
          onChange={(event) => setDraft({ ...draft, result_status: event.target.value as QcResultStatus })}
          className="lg:col-span-2 rounded-md border border-border bg-background px-3 py-2 text-xs"
        >
          {QC_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        <input
          value={draft.measured_values}
          onChange={(event) => setDraft({ ...draft, measured_values: event.target.value })}
          placeholder='{"control": 1.23}'
          className="lg:col-span-4 rounded-md border border-border bg-background px-3 py-2 text-xs font-mono"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="lg:col-span-2 inline-flex items-center justify-center gap-1 rounded-md bg-primary px-2 py-2 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          Record QC
        </button>
        <input
          value={draft.notes}
          onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
          placeholder="Notes"
          className="lg:col-span-12 rounded-md border border-border bg-background px-3 py-2 text-xs"
        />
      </div>
      {loading ? (
        <LoadingSpinner label="Loading QC runs" />
      ) : qcRuns.length === 0 ? (
        <EmptyState title="No QC runs" description="Record the first QC result for this analyzer." compact />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">time</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">level</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">result</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">lot</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground">notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {qcRuns.map((run) => (
                <tr key={run.id}>
                  <td className="px-3 py-2 text-muted-foreground">{fmt(run.performed_at)}</td>
                  <td className="px-3 py-2">{run.qc_level}</td>
                  <td className="px-3 py-2"><Pill value={run.result_status} /></td>
                  <td className="px-3 py-2 font-mono">{run.qc_lot_number ?? "-"}</td>
                  <td className="px-3 py-2">{run.notes ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
