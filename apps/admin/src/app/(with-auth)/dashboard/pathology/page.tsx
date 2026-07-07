// src/app/(with-auth)/dashboard/pathology/page.tsx
"use client";

import { Suspense, useMemo, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CheckCircle2,
  Clock,
  FileText,
  Layers,
  MessageSquarePlus,
  Microscope,
  PanelTop,
  Plus,
  RefreshCw,
} from "lucide-react";
import { fetchAdminAPI, postJSON, putJSON } from "@/lib/api";
import { useRealtimeInvalidation } from "@/hooks/useRealtimeInvalidation";

const PATHOLOGY_CHANNEL = "staff:pathology";
const WORKLIST_KEY = ["pathology", "worklist"];
const TAT_KEY = ["pathology", "tat"];

type ApCaseRow = {
  id: number;
  case_number: string;
  patient_uid: string;
  case_kind: string;
  priority: string;
  status: string;
  accessioned_at: string;
  report_id?: number | null;
  report_status?: string | null;
  signed_at?: string | null;
  specimen_count?: number | null;
  block_count?: number | null;
  slide_count?: number | null;
  target_hours?: number | null;
  elapsed_hours?: number | null;
  current_tat_stage?: string | null;
  breached?: boolean | null;
};

type ApBlock = {
  id: number;
  block_code: string;
  tissue_site?: string | null;
  status: string;
};

type ApSlide = {
  id: number;
  slide_code: string;
  block_id: number;
  stain_type: string;
  status: string;
};

type ApReport = {
  id: number;
  report_status: string;
  malignancy_flag: string;
  signed_at?: string | null;
};

type ApCaseDetail = {
  case: ApCaseRow;
  gross_records: { id: number; recorded_at: string }[];
  blocks: ApBlock[];
  slides: ApSlide[];
  report: ApReport | null;
  addenda: { id: number; addendum_at: string }[];
};

type ActiveTab = "worklist" | "accession" | "tat";

const STATUS_COLORS: Record<string, string> = {
  accessioned: "bg-sky-100 text-sky-800",
  grossing: "bg-amber-100 text-amber-800",
  processing: "bg-indigo-100 text-indigo-800",
  slides_ready: "bg-violet-100 text-violet-800",
  reported: "bg-cyan-100 text-cyan-800",
  signed: "bg-emerald-100 text-emerald-800",
  amended: "bg-fuchsia-100 text-fuchsia-800",
  cancelled: "bg-slate-100 text-slate-600",
};

const PRIORITY_COLORS: Record<string, string> = {
  stat: "bg-red-100 text-red-800",
  urgent: "bg-orange-100 text-orange-800",
  routine: "bg-slate-100 text-slate-700",
};

function unwrapList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    const obj = value as { data?: unknown; items?: unknown };
    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return [];
}

function fmtDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function titleize(value?: string | null) {
  return String(value || "-").replace(/_/g, " ");
}

function Badge({ value, colors }: { value?: string | null; colors: Record<string, string> }) {
  const key = String(value || "").toLowerCase();
  return (
    <span className={`inline-flex min-w-24 justify-center rounded-full px-2 py-1 text-xs font-medium ${colors[key] ?? "bg-gray-100 text-gray-700"}`}>
      {titleize(value)}
    </span>
  );
}

function parseSpecimenIds(value: string) {
  return value
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

function PathologyDashboard() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ActiveTab>("worklist");
  const [selectedCaseId, setSelectedCaseId] = useState<number | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<number | "">("");
  const [accessionForm, setAccessionForm] = useState({
    patient_uid: "",
    specimen_ids: "",
    case_kind: "histopathology",
    priority: "routine",
    clinical_history: "",
  });
  const [grossText, setGrossText] = useState("");
  const [blockForm, setBlockForm] = useState({ tissue_site: "", cassette_label: "" });
  const [slideForm, setSlideForm] = useState({ stain_type: "h_and_e", stain_name: "" });
  const [reportForm, setReportForm] = useState({
    report_status: "draft",
    gross_text: "",
    microscopic_text: "",
    diagnosis_text: "",
    malignancy_flag: "not_assessed",
  });
  const [addendumText, setAddendumText] = useState("");

  useRealtimeInvalidation(PATHOLOGY_CHANNEL, [WORKLIST_KEY, TAT_KEY]);

  const worklist = useQuery({
    queryKey: WORKLIST_KEY,
    queryFn: async () => unwrapList<ApCaseRow>(await fetchAdminAPI<unknown>("/pathology/worklist?limit=50")),
    refetchInterval: 60_000,
  });

  const tatMetrics = useQuery({
    queryKey: TAT_KEY,
    queryFn: async () => unwrapList<ApCaseRow>(await fetchAdminAPI<unknown>("/pathology/tat-metrics?limit=50")),
    refetchInterval: 60_000,
  });

  const detail = useQuery({
    queryKey: ["pathology", "case", selectedCaseId],
    enabled: selectedCaseId != null,
    queryFn: async () => fetchAdminAPI<ApCaseDetail>(`/pathology/cases/${selectedCaseId}`),
  });

  const selectedCase = useMemo(
    () => worklist.data?.find((row) => row.id === selectedCaseId) ?? detail.data?.case ?? null,
    [detail.data?.case, selectedCaseId, worklist.data],
  );
  const tabs: { key: ActiveTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
    { key: "worklist", label: "Worklist", icon: Microscope },
    { key: "accession", label: "Accession", icon: Plus },
    { key: "tat", label: "TAT", icon: Clock },
  ];

  const invalidatePathology = () => {
    queryClient.invalidateQueries({ queryKey: WORKLIST_KEY });
    queryClient.invalidateQueries({ queryKey: TAT_KEY });
    if (selectedCaseId != null) queryClient.invalidateQueries({ queryKey: ["pathology", "case", selectedCaseId] });
  };

  const accessionMutation = useMutation({
    mutationFn: async () => {
      const specimenIds = parseSpecimenIds(accessionForm.specimen_ids);
      if (specimenIds.length === 0) throw new Error("Enter specimen IDs");
      return postJSON<ApCaseDetail>("/api/v1/pathology/cases", {
        patient_uid: accessionForm.patient_uid,
        specimen_ids: specimenIds,
        case_kind: accessionForm.case_kind,
        priority: accessionForm.priority,
        clinical_history: accessionForm.clinical_history || undefined,
      });
    },
    onSuccess: (result) => {
      setSelectedCaseId(result.case.id);
      setActiveTab("worklist");
      setAccessionForm({ patient_uid: "", specimen_ids: "", case_kind: "histopathology", priority: "routine", clinical_history: "" });
      invalidatePathology();
    },
  });

  const grossMutation = useMutation({
    mutationFn: () => postJSON(`/api/v1/pathology/cases/${selectedCaseId}/gross`, { gross_text: grossText }),
    onSuccess: () => {
      setGrossText("");
      invalidatePathology();
    },
  });

  const blockMutation = useMutation({
    mutationFn: () => postJSON<ApBlock>(`/api/v1/pathology/cases/${selectedCaseId}/blocks`, blockForm),
    onSuccess: (block) => {
      setSelectedBlockId(block.id);
      setBlockForm({ tissue_site: "", cassette_label: "" });
      invalidatePathology();
    },
  });

  const slideMutation = useMutation({
    mutationFn: () => {
      const blockId = selectedBlockId || detail.data?.blocks[0]?.id;
      if (!blockId) throw new Error("Create or select a block");
      return postJSON(`/api/v1/pathology/blocks/${blockId}/slides`, slideForm);
    },
    onSuccess: () => {
      setSlideForm({ stain_type: "h_and_e", stain_name: "" });
      invalidatePathology();
    },
  });

  const reportMutation = useMutation({
    mutationFn: () => putJSON(`/api/v1/pathology/cases/${selectedCaseId}/report`, reportForm),
    onSuccess: () => invalidatePathology(),
  });

  const signMutation = useMutation({
    mutationFn: () => {
      const reportId = detail.data?.report?.id ?? selectedCase?.report_id;
      if (!reportId) throw new Error("Draft the report first");
      return postJSON(`/api/v1/pathology/reports/${reportId}/sign-off`, {});
    },
    onSuccess: () => invalidatePathology(),
  });

  const addendumMutation = useMutation({
    mutationFn: () => {
      const reportId = detail.data?.report?.id ?? selectedCase?.report_id;
      if (!reportId) throw new Error("Sign the report first");
      return postJSON(`/api/v1/pathology/reports/${reportId}/addenda`, { addendum_text: addendumText });
    },
    onSuccess: () => {
      setAddendumText("");
      invalidatePathology();
    },
  });

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Anatomic Pathology</h1>
          <p className="text-sm text-muted-foreground">Histopathology and cytology reporting</p>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
          onClick={() => {
            worklist.refetch();
            tatMetrics.refetch();
            if (selectedCaseId) detail.refetch();
          }}
        >
          <RefreshCw className="h-4 w-4" />
          Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-2">
        {tabs.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
              activeTab === key ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"
            }`}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "worklist" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(360px,0.8fr)]">
          <section className="rounded-lg border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">AP Worklist</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3">Case</th>
                    <th className="px-4 py-3">Patient</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Priority</th>
                    <th className="px-4 py-3">Workflow</th>
                    <th className="px-4 py-3">TAT</th>
                    <th className="px-4 py-3">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {(worklist.data ?? []).map((row) => (
                    <tr key={row.id} className="border-t border-border">
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.case_number}</div>
                        <div className="text-xs text-muted-foreground">{titleize(row.case_kind)}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{row.patient_uid}</td>
                      <td className="px-4 py-3"><Badge value={row.status} colors={STATUS_COLORS} /></td>
                      <td className="px-4 py-3"><Badge value={row.priority} colors={PRIORITY_COLORS} /></td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">
                        {row.specimen_count ?? 0} sp / {row.block_count ?? 0} bl / {row.slide_count ?? 0} sl
                      </td>
                      <td className="px-4 py-3">
                        <div className={row.breached ? "text-red-700" : "text-muted-foreground"}>
                          {row.elapsed_hours ?? "-"}h / {row.target_hours ?? "-"}h
                        </div>
                        <div className="text-xs text-muted-foreground">{titleize(row.current_tat_stage)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
                          onClick={() => setSelectedCaseId(row.id)}
                        >
                          Select
                        </button>
                      </td>
                    </tr>
                  ))}
                  {worklist.isLoading && (
                    <tr><td className="px-4 py-6 text-muted-foreground" colSpan={7}>Loading...</td></tr>
                  )}
                  {!worklist.isLoading && (worklist.data ?? []).length === 0 && (
                    <tr><td className="px-4 py-6 text-muted-foreground" colSpan={7}>No AP cases in the current worklist.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <WorkflowPanel
            selectedCase={selectedCase}
            detail={detail.data}
            detailLoading={detail.isLoading}
            grossText={grossText}
            setGrossText={setGrossText}
            grossBusy={grossMutation.isPending}
            onGross={() => grossMutation.mutate()}
            blockForm={blockForm}
            setBlockForm={setBlockForm}
            blockBusy={blockMutation.isPending}
            onBlock={() => blockMutation.mutate()}
            selectedBlockId={selectedBlockId}
            setSelectedBlockId={setSelectedBlockId}
            slideForm={slideForm}
            setSlideForm={setSlideForm}
            slideBusy={slideMutation.isPending}
            onSlide={() => slideMutation.mutate()}
            reportForm={reportForm}
            setReportForm={setReportForm}
            reportBusy={reportMutation.isPending}
            onReport={() => reportMutation.mutate()}
            signBusy={signMutation.isPending}
            onSign={() => signMutation.mutate()}
            addendumText={addendumText}
            setAddendumText={setAddendumText}
            addendumBusy={addendumMutation.isPending}
            onAddendum={() => addendumMutation.mutate()}
          />
        </div>
      )}

      {activeTab === "accession" && (
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Accession Case</h2>
          </div>
          <div className="grid gap-4 p-4 md:grid-cols-2">
            <Field label="Patient UID">
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={accessionForm.patient_uid}
                onChange={(e) => setAccessionForm((form) => ({ ...form, patient_uid: e.target.value }))}
              />
            </Field>
            <Field label="Specimen IDs">
              <input
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={accessionForm.specimen_ids}
                onChange={(e) => setAccessionForm((form) => ({ ...form, specimen_ids: e.target.value }))}
              />
            </Field>
            <Field label="Case kind">
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={accessionForm.case_kind}
                onChange={(e) => setAccessionForm((form) => ({ ...form, case_kind: e.target.value }))}
              >
                <option value="histopathology">Histopathology</option>
                <option value="cytology">Cytology</option>
                <option value="frozen_section">Frozen section</option>
              </select>
            </Field>
            <Field label="Priority">
              <select
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={accessionForm.priority}
                onChange={(e) => setAccessionForm((form) => ({ ...form, priority: e.target.value }))}
              >
                <option value="routine">Routine</option>
                <option value="urgent">Urgent</option>
                <option value="stat">STAT</option>
              </select>
            </Field>
            <Field label="Clinical history" className="md:col-span-2">
              <textarea
                className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                value={accessionForm.clinical_history}
                onChange={(e) => setAccessionForm((form) => ({ ...form, clinical_history: e.target.value }))}
              />
            </Field>
            <div className="md:col-span-2">
              <button
                type="button"
                disabled={accessionMutation.isPending}
                onClick={() => accessionMutation.mutate()}
                className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                Accession
              </button>
            </div>
          </div>
        </section>
      )}

      {activeTab === "tat" && (
        <section className="rounded-lg border border-border bg-card">
          <div className="border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Turnaround Metrics</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">Case</th>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Stage</th>
                  <th className="px-4 py-3">Elapsed</th>
                  <th className="px-4 py-3">Target</th>
                  <th className="px-4 py-3">Accessioned</th>
                </tr>
              </thead>
              <tbody>
                {(tatMetrics.data ?? []).map((row) => (
                  <tr key={row.id ?? row.case_number} className="border-t border-border">
                    <td className="px-4 py-3 font-medium">{row.case_number}</td>
                    <td className="px-4 py-3">{titleize(row.case_kind)}</td>
                    <td className="px-4 py-3"><Badge value={row.priority} colors={PRIORITY_COLORS} /></td>
                    <td className="px-4 py-3">{titleize(row.current_tat_stage)}</td>
                    <td className={`px-4 py-3 ${row.breached ? "font-medium text-red-700" : ""}`}>{row.elapsed_hours ?? "-"}h</td>
                    <td className="px-4 py-3">{row.target_hours ?? "-"}h</td>
                    <td className="px-4 py-3">{fmtDate(row.accessioned_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function WorkflowPanel(props: {
  selectedCase: ApCaseRow | null;
  detail?: ApCaseDetail;
  detailLoading: boolean;
  grossText: string;
  setGrossText: (value: string) => void;
  grossBusy: boolean;
  onGross: () => void;
  blockForm: { tissue_site: string; cassette_label: string };
  setBlockForm: (value: { tissue_site: string; cassette_label: string }) => void;
  blockBusy: boolean;
  onBlock: () => void;
  selectedBlockId: number | "";
  setSelectedBlockId: (value: number | "") => void;
  slideForm: { stain_type: string; stain_name: string };
  setSlideForm: (value: { stain_type: string; stain_name: string }) => void;
  slideBusy: boolean;
  onSlide: () => void;
  reportForm: { report_status: string; gross_text: string; microscopic_text: string; diagnosis_text: string; malignancy_flag: string };
  setReportForm: (value: { report_status: string; gross_text: string; microscopic_text: string; diagnosis_text: string; malignancy_flag: string }) => void;
  reportBusy: boolean;
  onReport: () => void;
  signBusy: boolean;
  onSign: () => void;
  addendumText: string;
  setAddendumText: (value: string) => void;
  addendumBusy: boolean;
  onAddendum: () => void;
}) {
  if (!props.selectedCase) {
    return (
      <section className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Select a pathology case.
      </section>
    );
  }

  const reportId = props.detail?.report?.id ?? props.selectedCase.report_id;
  const signed = Boolean(props.detail?.report?.signed_at ?? props.selectedCase.signed_at);
  const defaultBlockId = props.selectedBlockId || props.detail?.blocks[0]?.id || "";

  return (
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">{props.selectedCase.case_number}</h2>
            <p className="text-xs text-muted-foreground">{fmtDate(props.selectedCase.accessioned_at)}</p>
          </div>
          <Badge value={props.selectedCase.status} colors={STATUS_COLORS} />
        </div>
      </div>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-3 gap-2 text-xs">
          <MiniStat icon={BookOpen} label="Gross" value={String(props.detail?.gross_records.length ?? (props.detailLoading ? "..." : 0))} />
          <MiniStat icon={Layers} label="Blocks" value={String(props.detail?.blocks.length ?? (props.detailLoading ? "..." : 0))} />
          <MiniStat icon={PanelTop} label="Slides" value={String(props.detail?.slides.length ?? (props.detailLoading ? "..." : 0))} />
        </div>

        <ActionBox icon={BookOpen} title="Grossing">
          <textarea
            className="min-h-20 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={props.grossText}
            onChange={(e) => props.setGrossText(e.target.value)}
          />
          <button
            type="button"
            disabled={props.grossBusy || props.grossText.trim().length === 0}
            onClick={props.onGross}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            <BookOpen className="h-4 w-4" />
            Save Gross
          </button>
        </ActionBox>

        <ActionBox icon={Layers} title="Blocks">
          <div className="grid gap-2 md:grid-cols-2">
            <input
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Tissue site"
              value={props.blockForm.tissue_site}
              onChange={(e) => props.setBlockForm({ ...props.blockForm, tissue_site: e.target.value })}
            />
            <input
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Cassette label"
              value={props.blockForm.cassette_label}
              onChange={(e) => props.setBlockForm({ ...props.blockForm, cassette_label: e.target.value })}
            />
          </div>
          <button
            type="button"
            disabled={props.blockBusy}
            onClick={props.onBlock}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            <Layers className="h-4 w-4" />
            Create Block
          </button>
        </ActionBox>

        <ActionBox icon={PanelTop} title="Slides">
          <div className="grid gap-2 md:grid-cols-3">
            <select
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={defaultBlockId}
              onChange={(e) => props.setSelectedBlockId(e.target.value ? Number(e.target.value) : "")}
            >
              <option value="">Block</option>
              {(props.detail?.blocks ?? []).map((block) => (
                <option key={block.id} value={block.id}>{block.block_code}</option>
              ))}
            </select>
            <select
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={props.slideForm.stain_type}
              onChange={(e) => props.setSlideForm({ ...props.slideForm, stain_type: e.target.value })}
            >
              <option value="h_and_e">H and E</option>
              <option value="special">Special</option>
              <option value="ihc">IHC</option>
              <option value="cytology">Cytology</option>
            </select>
            <input
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Stain name"
              value={props.slideForm.stain_name}
              onChange={(e) => props.setSlideForm({ ...props.slideForm, stain_name: e.target.value })}
            />
          </div>
          <button
            type="button"
            disabled={props.slideBusy || !defaultBlockId}
            onClick={props.onSlide}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            <PanelTop className="h-4 w-4" />
            Create Slide
          </button>
        </ActionBox>

        <ActionBox icon={FileText} title="Report">
          <div className="grid gap-2">
            <select
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={props.reportForm.report_status}
              onChange={(e) => props.setReportForm({ ...props.reportForm, report_status: e.target.value })}
            >
              <option value="draft">Draft</option>
              <option value="preliminary">Preliminary</option>
            </select>
            <textarea
              className="min-h-16 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Gross summary"
              value={props.reportForm.gross_text}
              onChange={(e) => props.setReportForm({ ...props.reportForm, gross_text: e.target.value })}
            />
            <textarea
              className="min-h-16 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Microscopy"
              value={props.reportForm.microscopic_text}
              onChange={(e) => props.setReportForm({ ...props.reportForm, microscopic_text: e.target.value })}
            />
            <textarea
              className="min-h-20 rounded-md border border-border bg-background px-3 py-2 text-sm"
              placeholder="Diagnosis"
              value={props.reportForm.diagnosis_text}
              onChange={(e) => props.setReportForm({ ...props.reportForm, diagnosis_text: e.target.value })}
            />
            <select
              className="rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={props.reportForm.malignancy_flag}
              onChange={(e) => props.setReportForm({ ...props.reportForm, malignancy_flag: e.target.value })}
            >
              <option value="not_assessed">Not assessed</option>
              <option value="benign">Benign</option>
              <option value="premalignant">Premalignant</option>
              <option value="malignant">Malignant</option>
              <option value="suspicious">Suspicious</option>
              <option value="inadequate">Inadequate</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={props.reportBusy || signed}
              onClick={props.onReport}
              className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
            >
              <FileText className="h-4 w-4" />
              Save Report
            </button>
            <button
              type="button"
              disabled={props.signBusy || !reportId || signed}
              onClick={props.onSign}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-50"
            >
              <CheckCircle2 className="h-4 w-4" />
              Sign Off
            </button>
          </div>
        </ActionBox>

        <ActionBox icon={MessageSquarePlus} title="Addendum">
          <textarea
            className="min-h-16 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
            value={props.addendumText}
            onChange={(e) => props.setAddendumText(e.target.value)}
          />
          <button
            type="button"
            disabled={props.addendumBusy || !signed || props.addendumText.trim().length === 0}
            onClick={props.onAddendum}
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm disabled:opacity-50"
          >
            <MessageSquarePlus className="h-4 w-4" />
            Append Addendum
          </button>
        </ActionBox>
      </div>
    </section>
  );
}

function Field({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`space-y-1 text-sm ${className}`}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function ActionBox({ icon: Icon, title, children }: { icon: ComponentType<{ className?: string }>; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="h-4 w-4" />
        {title}
      </div>
      {children}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value }: { icon: ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div className="p-6">Loading pathology...</div>}>
      <PathologyDashboard />
    </Suspense>
  );
}
