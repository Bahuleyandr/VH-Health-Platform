"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CopyPlus,
  FileJson,
  FlaskConical,
  History,
  Import,
  ListFilter,
  RefreshCw,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { toast } from "react-hot-toast";

import { fetchAdminAPI } from "@/lib/api";

type OrderSetStatus = "draft" | "in_review" | "approved" | "retired";
type StatusFilter = "all" | OrderSetStatus;

type OrderSetItem = {
  id: number;
  display_order: number;
  kind: string;
  payload: Record<string, unknown>;
  default_selected: boolean;
};

type ReviewEvent = {
  id: number;
  action: string;
  actor_role: string | null;
  note: string | null;
  created_at: string;
};

type OrderSetRow = {
  id: number;
  code: string;
  family_key: string;
  version: number;
  status: OrderSetStatus;
  active: boolean;
  title: string;
  specialty: string | null;
  condition_codes: string[];
  approved_at: string | null;
  approved_by: string | null;
  review_note: string | null;
  source: "authored" | "imported";
  requires_pharmacy_review: boolean;
  has_pharmacy_review: boolean;
  items: OrderSetItem[];
  events: ReviewEvent[];
};

type StudioSettings = {
  tenant_id: string;
  enabled: boolean;
};

type ImportPreview = {
  dry_run?: boolean;
  family_key?: string;
  title?: string;
  row_count?: number;
  warnings?: unknown[];
  requires_pharmacy_review?: boolean;
  order_set?: OrderSetRow;
};

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "draft", label: "Drafts" },
  { key: "in_review", label: "Review" },
  { key: "approved", label: "Deployed" },
  { key: "retired", label: "Retired" },
];

const SAMPLE_IMPORT = JSON.stringify(
  {
    format: "vh-order-set/1",
    family_key: "ADULT-CAP-INITIAL",
    title: "Adult community-acquired pneumonia initial bundle",
    specialty: "General Medicine",
    condition_codes: ["J18.9"],
    phases: [
      {
        phase: "initial",
        items: [
          {
            kind: "lab",
            display_order: 1,
            payload: { test_name: "CBC with differential", urgency: "urgent" },
          },
          {
            kind: "radiology",
            display_order: 2,
            payload: {
              modality: "xray",
              body_part: "chest",
              clinical_indication: "Suspected pneumonia",
            },
          },
          {
            kind: "med",
            display_order: 3,
            payload: {
              medication_name: "Ceftriaxone",
              dose: "1 g",
              route: "IV",
              frequency: "once daily",
            },
          },
        ],
      },
    ],
  },
  null,
  2,
);

function statusClass(status: OrderSetStatus) {
  switch (status) {
    case "approved":
      return "border-emerald-300 bg-emerald-50 text-emerald-800";
    case "in_review":
      return "border-amber-300 bg-amber-50 text-amber-800";
    case "retired":
      return "border-slate-300 bg-slate-100 text-slate-700";
    default:
      return "border-sky-300 bg-sky-50 text-sky-800";
  }
}

function itemLabel(item: OrderSetItem) {
  const payload = item.payload || {};
  return String(
    payload.medication_name ||
      payload.test_name ||
      payload.task ||
      payload.modality ||
      payload.procedure_name ||
      payload.name ||
      item.kind,
  );
}

function formatDate(value: string | null) {
  if (!value) return "Not deployed";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function ActionButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex min-h-9 items-center gap-1.5 rounded border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5" />
      <span>{label}</span>
    </button>
  );
}

export default function OrderSetStudioPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>("all");
  const [note, setNote] = useState("");
  const [importText, setImportText] = useState(SAMPLE_IMPORT);
  const [preview, setPreview] = useState<ImportPreview | null>(null);

  const queryKey = useMemo(() => ["order-set-studio", status], [status]);
  const queue = useQuery({
    queryKey,
    queryFn: () =>
      fetchAdminAPI<OrderSetRow[]>(
        `/emr/order-sets/studio${status === "all" ? "" : `?status=${status}`}`,
      ),
  });

  const settings = useQuery({
    queryKey: ["order-set-studio", "settings"],
    queryFn: () => fetchAdminAPI<StudioSettings>("/emr/order-sets/studio/settings"),
  });

  const rows = queue.data ?? [];
  const counts = rows.reduce<Record<OrderSetStatus, number>>(
    (acc, row) => {
      acc[row.status] += 1;
      return acc;
    },
    { draft: 0, in_review: 0, approved: 0, retired: 0 },
  );

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["order-set-studio"] });
  };

  const lifecycle = useMutation({
    mutationFn: ({ endpoint, body }: { endpoint: string; body?: unknown }) =>
      fetchAdminAPI<unknown>(endpoint, { method: "POST", body }),
    onSuccess: () => {
      toast.success("Order-set state updated");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const settingMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      fetchAdminAPI<StudioSettings>("/emr/order-sets/studio/settings", {
        method: "POST",
        body: {
          enabled,
          acceptance_snapshot: {
            accepted_from: "admin/order-set-studio",
            accepted_at: new Date().toISOString(),
          },
        },
      }),
    onSuccess: () => {
      toast.success("Studio setting updated");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const dryRun = useMutation({
    mutationFn: async () => {
      const document = JSON.parse(importText) as Record<string, unknown>;
      return fetchAdminAPI<ImportPreview>("/emr/order-sets/import", {
        method: "POST",
        body: { dry_run: true, source_file: "admin-studio.json", document },
      });
    },
    onSuccess: (result) => {
      setPreview(result);
      toast.success("Import dry run complete");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const importDraft = useMutation({
    mutationFn: async () => {
      const document = JSON.parse(importText) as Record<string, unknown>;
      return fetchAdminAPI<ImportPreview>("/emr/order-sets/import", {
        method: "POST",
        body: { dry_run: false, source_file: "admin-studio.json", document },
      });
    },
    onSuccess: (result) => {
      setPreview(result);
      toast.success("Draft imported");
      invalidate();
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const runAction = (row: OrderSetRow, action: string) => {
    lifecycle.mutate({
      endpoint: `/emr/order-sets/${row.id}/${action}`,
      body: { note: note || null },
    });
  };

  const busy =
    lifecycle.isPending ||
    settingMutation.isPending ||
    dryRun.isPending ||
    importDraft.isPending;

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Order-Set Content Studio</h1>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-border px-2 py-1">Draft {counts.draft}</span>
            <span className="rounded border border-border px-2 py-1">Review {counts.in_review}</span>
            <span className="rounded border border-border px-2 py-1">Deployed {counts.approved}</span>
            <span className="rounded border border-border px-2 py-1">Retired {counts.retired}</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton
            icon={Settings2}
            label={settings.data?.enabled ? "Disable drafts" : "Enable drafts"}
            onClick={() => settingMutation.mutate(!settings.data?.enabled)}
            disabled={busy || settings.isLoading}
          />
          <ActionButton
            icon={RefreshCw}
            label="Refresh"
            onClick={() => invalidate()}
            disabled={busy || queue.isFetching}
          />
        </div>
      </header>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          <div className="flex flex-col gap-3 rounded border border-border bg-card p-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-1">
              <ListFilter className="h-4 w-4 text-muted-foreground" />
              {STATUS_FILTERS.map((filter) => (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => setStatus(filter.key)}
                  className={`rounded px-3 py-1.5 text-xs font-medium ${
                    status === filter.key
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Review note"
              className="min-h-9 w-full rounded border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary lg:max-w-md"
            />
          </div>

          {queue.isLoading ? (
            <div className="rounded border border-border bg-card p-6 text-sm text-muted-foreground">
              Loading order sets...
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded border border-border bg-card p-6 text-sm text-muted-foreground">
              No order sets match this queue.
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map((row) => (
                <article key={row.id} className="rounded border border-border bg-card p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-foreground">{row.title}</h2>
                        <span className={`rounded border px-2 py-0.5 text-xs ${statusClass(row.status)}`}>
                          {row.status}
                        </span>
                        <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          v{row.version}
                        </span>
                        <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {row.source}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                        <span>{row.family_key}</span>
                        {row.specialty ? <span>{row.specialty}</span> : null}
                        {row.condition_codes?.length ? <span>{row.condition_codes.join(", ")}</span> : null}
                        <span>{formatDate(row.approved_at)}</span>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {row.status === "draft" ? (
                        <ActionButton
                          icon={Send}
                          label="Submit"
                          onClick={() => runAction(row, "submit")}
                          disabled={busy}
                        />
                      ) : null}
                      {row.status === "in_review" && row.requires_pharmacy_review ? (
                        <ActionButton
                          icon={FlaskConical}
                          label={row.has_pharmacy_review ? "Pharmacy done" : "Pharmacy review"}
                          onClick={() => runAction(row, "pharmacy-review")}
                          disabled={busy || row.has_pharmacy_review}
                        />
                      ) : null}
                      {row.status === "in_review" ? (
                        <>
                          <ActionButton
                            icon={Check}
                            label="Approve"
                            onClick={() => runAction(row, "approve")}
                            disabled={busy}
                          />
                          <ActionButton
                            icon={X}
                            label="Reject"
                            onClick={() => runAction(row, "reject")}
                            disabled={busy}
                          />
                        </>
                      ) : null}
                      {row.status === "approved" ? (
                        <>
                          <ActionButton
                            icon={CopyPlus}
                            label="New draft"
                            onClick={() => runAction(row, "new-version")}
                            disabled={busy}
                          />
                          <ActionButton
                            icon={RotateCcw}
                            label="Rollback"
                            onClick={() => runAction(row, "rollback")}
                            disabled={busy}
                          />
                          <ActionButton
                            icon={Trash2}
                            label="Retire"
                            onClick={() => runAction(row, "retire")}
                            disabled={busy}
                          />
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
                    <div className="overflow-hidden rounded border border-border">
                      <table className="w-full table-fixed text-sm">
                        <thead className="bg-muted/50 text-xs text-muted-foreground">
                          <tr>
                            <th className="w-16 px-3 py-2 text-left font-medium">#</th>
                            <th className="w-28 px-3 py-2 text-left font-medium">Kind</th>
                            <th className="px-3 py-2 text-left font-medium">Item</th>
                          </tr>
                        </thead>
                        <tbody>
                          {row.items.map((item) => (
                            <tr key={item.id} className="border-t border-border">
                              <td className="px-3 py-2 text-muted-foreground">{item.display_order}</td>
                              <td className="px-3 py-2 text-muted-foreground">{item.kind}</td>
                              <td className="truncate px-3 py-2 text-foreground">{itemLabel(item)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="rounded border border-border p-3">
                      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                        <History className="h-3.5 w-3.5" />
                        Events
                      </div>
                      <div className="mt-2 space-y-2">
                        {row.events.slice(-4).map((event) => (
                          <div key={event.id} className="text-xs">
                            <div className="font-medium text-foreground">{event.action}</div>
                            <div className="text-muted-foreground">
                              {event.actor_role || "actor"} / {formatDate(event.created_at)}
                            </div>
                          </div>
                        ))}
                        {row.events.length === 0 ? (
                          <div className="text-xs text-muted-foreground">No review events</div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <aside className="space-y-3 rounded border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileJson className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Import</h2>
            </div>
            <span className="rounded border border-border px-2 py-0.5 text-xs text-muted-foreground">
              vh-order-set/1
            </span>
          </div>
          <textarea
            value={importText}
            onChange={(event) => setImportText(event.target.value)}
            spellCheck={false}
            className="min-h-[360px] w-full resize-y rounded border border-border bg-background p-3 font-mono text-xs leading-5 outline-none focus:border-primary"
          />
          <div className="flex flex-wrap gap-2">
            <ActionButton icon={FileJson} label="Dry run" onClick={() => dryRun.mutate()} disabled={busy} />
            <ActionButton icon={Import} label="Import draft" onClick={() => importDraft.mutate()} disabled={busy} />
          </div>
          {preview ? (
            <div className="rounded border border-border bg-muted/30 p-3 text-xs">
              <div className="font-medium text-foreground">{preview.title || preview.order_set?.title}</div>
              <div className="mt-1 text-muted-foreground">
                {preview.family_key || preview.order_set?.family_key} / {preview.row_count ?? preview.order_set?.items.length ?? 0} rows
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <span className="rounded border border-border px-2 py-0.5">
                  Warnings {preview.warnings?.length ?? 0}
                </span>
                <span className="rounded border border-border px-2 py-0.5">
                  Pharmacy {preview.requires_pharmacy_review || preview.order_set?.requires_pharmacy_review ? "required" : "clear"}
                </span>
              </div>
            </div>
          ) : null}
        </aside>
      </section>
    </div>
  );
}
