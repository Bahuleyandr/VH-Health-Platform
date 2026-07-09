"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Map,
  PlayCircle,
  RefreshCw,
  Save,
} from "lucide-react";
import { toast } from "react-hot-toast";
import {
  downloadTrainingEvidenceCsv,
  getAdoptionSummary,
  saveHelpCategory,
  saveLearningModule,
  saveTourDefinition,
  type AdoptionSummary,
  type HelpCategoryPayload,
  type LearningModulePayload,
  type TourPayload,
} from "@/lib/api/adoption";

type ModuleForm = {
  module_key: string;
  title: string;
  category_key: string;
  summary: string;
  content_markdown: string;
  role_scope: string;
  required_for_roles: string;
  status: string;
  estimated_minutes: string;
  control_code: string;
};

type CategoryForm = {
  category_key: string;
  label: string;
  description: string;
  role_scope: string;
  sort_order: string;
  status: string;
};

type TourForm = {
  tour_key: string;
  title: string;
  surface: string;
  route_pattern: string;
  role_scope: string;
  status: string;
  steps_json: string;
};

const blankModule: ModuleForm = {
  module_key: "staff-confidentiality-basics",
  title: "Staff confidentiality basics",
  category_key: "privacy-compliance",
  summary: "Required confidentiality and safe-record-handling primer.",
  content_markdown: "Use minimum necessary information and report suspected privacy incidents.",
  role_scope: "*",
  required_for_roles: "*",
  status: "published",
  estimated_minutes: "12",
  control_code: "NABH_STAFF_CONFIDENTIALITY_TRAINING",
};

const blankCategory: CategoryForm = {
  category_key: "privacy-compliance",
  label: "Privacy and compliance",
  description: "Confidentiality, consent, and audit basics.",
  role_scope: "*",
  sort_order: "10",
  status: "active",
};

const blankTour: TourForm = {
  tour_key: "admin-adoption-overview",
  title: "Adoption evidence overview",
  surface: "admin",
  route_pattern: "/dashboard/adoption",
  role_scope: "ADMIN,SUPER_ADMIN,QUALITY_OFFICER",
  status: "published",
  steps_json: JSON.stringify(
    [
      { key: "catalog", label: "Catalog", target: "#adoption-catalog" },
      { key: "evidence", label: "Evidence", target: "#training-evidence" },
    ],
    null,
    2,
  ),
};

function splitRoles(value: string) {
  return value
    .split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function parseSteps(value: string) {
  const parsed = JSON.parse(value || "[]") as Array<Record<string, unknown>>;
  if (!Array.isArray(parsed)) throw new Error("Steps must be a JSON array");
  return parsed;
}

function formatDate(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusPill({ value }: { value: string }) {
  const color =
    value === "published" || value === "active" || value === "completed" || value === "captured"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : value === "draft" || value === "started" || value === "step_viewed"
        ? "border-amber-200 bg-amber-50 text-amber-800"
        : "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-foreground">{value}</div>
    </div>
  );
}

function modulePayload(form: ModuleForm): LearningModulePayload {
  return {
    module_key: form.module_key.trim(),
    title: form.title.trim(),
    module_type: "role_manual",
    category_key: form.category_key.trim() || null,
    summary: form.summary.trim() || null,
    content_markdown: form.content_markdown,
    role_scope: splitRoles(form.role_scope),
    required_for_roles: splitRoles(form.required_for_roles),
    status: form.status,
    estimated_minutes: Number.parseInt(form.estimated_minutes, 10) || 5,
    metadata: {
      nabh_control_code: form.control_code.trim() || "TRAINING_COMPLETION",
    },
  };
}

function categoryPayload(form: CategoryForm): HelpCategoryPayload {
  return {
    category_key: form.category_key.trim(),
    label: form.label.trim(),
    description: form.description.trim() || null,
    role_scope: splitRoles(form.role_scope),
    sort_order: Number.parseInt(form.sort_order, 10) || 100,
    status: form.status,
  };
}

function tourPayload(form: TourForm): TourPayload {
  return {
    tour_key: form.tour_key.trim(),
    title: form.title.trim(),
    surface: form.surface.trim(),
    route_pattern: form.route_pattern.trim() || null,
    role_scope: splitRoles(form.role_scope),
    status: form.status,
    steps: parseSteps(form.steps_json),
    resume_policy: "resume_last_step",
    version: 1,
  };
}

function CatalogTables({ summary }: { summary: AdoptionSummary }) {
  return (
    <div id="adoption-catalog" className="grid gap-4 xl:grid-cols-3">
      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">Manuals</div>
        <div className="divide-y divide-border">
          {summary.modules.map((module) => (
            <div key={module.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-foreground">{module.title}</div>
                <StatusPill value={module.status} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {module.module_key} · v{module.version} · {module.estimated_minutes} min
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">Help Taxonomy</div>
        <div className="divide-y divide-border">
          {summary.categories.map((category) => (
            <div key={category.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-foreground">{category.label}</div>
                <StatusPill value={category.status} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {category.category_key} · order {category.sort_order}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-sm font-semibold">Tours</div>
        <div className="divide-y divide-border">
          {summary.tours.map((tour) => (
            <div key={tour.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium text-foreground">{tour.title}</div>
                <StatusPill value={tour.status} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {tour.tour_key} · {tour.surface} · {tour.steps.length} steps
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function EvidenceTable({ summary }: { summary: AdoptionSummary }) {
  return (
    <div id="training-evidence" className="rounded-md border border-border bg-card">
      <div className="border-b border-border px-4 py-3 text-sm font-semibold">Training Evidence</div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Control</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Subject</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Captured</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {summary.evidence_ledger.length === 0 ? (
              <tr>
                <td className="px-3 py-6 text-muted-foreground" colSpan={5}>
                  No evidence rows captured yet.
                </td>
              </tr>
            ) : (
              summary.evidence_ledger.map((row) => (
                <tr key={row.id}>
                  <td className="px-3 py-3 font-mono text-xs">{row.control_code}</td>
                  <td className="px-3 py-3">{row.title}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">
                    {row.subject_role ?? "-"}
                  </td>
                  <td className="px-3 py-3">
                    <StatusPill value={row.evidence_status} />
                  </td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{formatDate(row.created_at)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function AdoptionPage() {
  const queryClient = useQueryClient();
  const [moduleForm, setModuleForm] = useState<ModuleForm>({ ...blankModule });
  const [categoryForm, setCategoryForm] = useState<CategoryForm>({ ...blankCategory });
  const [tourForm, setTourForm] = useState<TourForm>({ ...blankTour });

  const summaryQuery = useQuery({
    queryKey: ["adoption"],
    queryFn: getAdoptionSummary,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["adoption"] });

  const moduleMutation = useMutation({
    mutationFn: () => saveLearningModule(modulePayload(moduleForm)),
    onSuccess: () => {
      toast.success("Manual saved");
      void refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Manual save failed"),
  });

  const categoryMutation = useMutation({
    mutationFn: () => saveHelpCategory(categoryPayload(categoryForm)),
    onSuccess: () => {
      toast.success("Category saved");
      void refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Category save failed"),
  });

  const tourMutation = useMutation({
    mutationFn: () => saveTourDefinition(tourPayload(tourForm)),
    onSuccess: () => {
      toast.success("Tour saved");
      void refresh();
    },
    onError: (err: Error) => toast.error(err.message || "Tour save failed"),
  });

  const csvMutation = useMutation({
    mutationFn: () => downloadTrainingEvidenceCsv(),
    onError: (err: Error) => toast.error(err.message || "Evidence export failed"),
  });

  const summary = summaryQuery.data;
  const capturedEvidence = useMemo(
    () => summary?.evidence_counts.reduce((sum, row) => sum + row.count, 0) ?? 0,
    [summary?.evidence_counts],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-medium uppercase tracking-wide text-teal-700">NL-11 Adoption</p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-950">Manuals, Tours, LMS</h1>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Role manuals, help taxonomy, tour events, and NABH training evidence.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void summaryQuery.refetch()}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => csvMutation.mutate()}
            disabled={csvMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-3 py-2 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-60"
          >
            <Download className="h-4 w-4" />
            Evidence CSV
          </button>
        </div>
      </div>

      {summaryQuery.isLoading && (
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          Loading adoption workspace...
        </div>
      )}

      {summaryQuery.error instanceof Error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {summaryQuery.error.message}
        </div>
      )}

      {summary && (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            <MetricCard icon={<BookOpen className="h-4 w-4" />} label="Manuals" value={summary.counts.modules} />
            <MetricCard icon={<Map className="h-4 w-4" />} label="Help Categories" value={summary.counts.categories} />
            <MetricCard icon={<PlayCircle className="h-4 w-4" />} label="Tours" value={summary.counts.tours} />
            <MetricCard icon={<ClipboardCheck className="h-4 w-4" />} label="Evidence Rows" value={capturedEvidence} />
          </div>

          <CatalogTables summary={summary} />

          <div className="grid gap-4 xl:grid-cols-3">
            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <BookOpen className="h-4 w-4" />
                Manual
              </div>
              <div className="space-y-3">
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={moduleForm.module_key} onChange={(e) => setModuleForm({ ...moduleForm, module_key: e.target.value })} placeholder="module key" />
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={moduleForm.title} onChange={(e) => setModuleForm({ ...moduleForm, title: e.target.value })} placeholder="title" />
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={moduleForm.category_key} onChange={(e) => setModuleForm({ ...moduleForm, category_key: e.target.value })} placeholder="category key" />
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={moduleForm.role_scope} onChange={(e) => setModuleForm({ ...moduleForm, role_scope: e.target.value })} placeholder="roles" />
                <textarea className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={moduleForm.content_markdown} onChange={(e) => setModuleForm({ ...moduleForm, content_markdown: e.target.value })} />
                <button type="button" onClick={() => moduleMutation.mutate()} disabled={moduleMutation.isPending} className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
                  <Save className="h-4 w-4" />
                  Save Manual
                </button>
              </div>
            </div>

            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <Map className="h-4 w-4" />
                Help Category
              </div>
              <div className="space-y-3">
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={categoryForm.category_key} onChange={(e) => setCategoryForm({ ...categoryForm, category_key: e.target.value })} placeholder="category key" />
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={categoryForm.label} onChange={(e) => setCategoryForm({ ...categoryForm, label: e.target.value })} placeholder="label" />
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={categoryForm.role_scope} onChange={(e) => setCategoryForm({ ...categoryForm, role_scope: e.target.value })} placeholder="roles" />
                <textarea className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={categoryForm.description} onChange={(e) => setCategoryForm({ ...categoryForm, description: e.target.value })} />
                <button type="button" onClick={() => categoryMutation.mutate()} disabled={categoryMutation.isPending} className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
                  <Save className="h-4 w-4" />
                  Save Category
                </button>
              </div>
            </div>

            <div className="rounded-md border border-border bg-card p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
                <PlayCircle className="h-4 w-4" />
                Tour
              </div>
              <div className="space-y-3">
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={tourForm.tour_key} onChange={(e) => setTourForm({ ...tourForm, tour_key: e.target.value })} placeholder="tour key" />
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={tourForm.title} onChange={(e) => setTourForm({ ...tourForm, title: e.target.value })} placeholder="title" />
                <input className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={tourForm.route_pattern} onChange={(e) => setTourForm({ ...tourForm, route_pattern: e.target.value })} placeholder="route" />
                <textarea className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs" value={tourForm.steps_json} onChange={(e) => setTourForm({ ...tourForm, steps_json: e.target.value })} />
                <button type="button" onClick={() => tourMutation.mutate()} disabled={tourMutation.isPending} className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">
                  <Save className="h-4 w-4" />
                  Save Tour
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(340px,1fr)]">
            <EvidenceTable summary={summary} />
            <div className="rounded-md border border-border bg-card">
              <div className="border-b border-border px-4 py-3 text-sm font-semibold">Recent Events</div>
              <div className="divide-y divide-border">
                {[...summary.recent_completions, ...summary.recent_tour_events]
                  .slice(0, 10)
                  .map((event, index) => (
                    <div key={`${index}:${"completed_at" in event ? event.completed_at : event.created_at}`} className="px-4 py-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-foreground">
                          {"module_key" in event ? event.title : event.title}
                        </span>
                        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {"module_key" in event ? event.status : event.event_type} · {formatDate("completed_at" in event ? event.completed_at : event.created_at)}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
