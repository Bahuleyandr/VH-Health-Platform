"use client";

// Admin master-data CRUD for day-care / surgical packages.
// Hits /api/v1/admin/billing-masters/packages:
//   GET   → list (filters: status, base_specialty)
//   PUT   → upsert (pass `id` to update, omit to create)
// Items editor deferred until service_catalog is populated.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { fetchAdminAPI } from "@/lib/api";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { EmptyState } from "@/components/EmptyState";

interface PackageRow {
  id: number;
  tenant_id: string;
  package_code: string;
  display_name: string;
  description: string | null;
  base_specialty: string | null;
  base_procedure_code: string | null;
  duration_days: number | null;
  fixed_price_minor: string | number | null;
  currency: string;
  status: "draft" | "active" | "paused" | "archived";
  inclusion_notes: string | null;
  exclusion_notes: string | null;
  created_at: string;
  updated_at: string;
}

interface PackageFormState {
  id: number | null;
  package_code: string;
  display_name: string;
  description: string;
  base_specialty: string;
  base_procedure_code: string;
  duration_days: string;
  price_rupees: string;
  currency: string;
  status: PackageRow["status"];
  inclusion_notes: string;
  exclusion_notes: string;
}

const EMPTY_FORM: PackageFormState = {
  id: null,
  package_code: "",
  display_name: "",
  description: "",
  base_specialty: "",
  base_procedure_code: "",
  duration_days: "1",
  price_rupees: "",
  currency: "INR",
  status: "active",
  inclusion_notes: "",
  exclusion_notes: "",
};

const STATUS_COLOURS: Record<PackageRow["status"], string> = {
  draft: "bg-slate-100 text-slate-700",
  active: "bg-emerald-100 text-emerald-800",
  paused: "bg-amber-100 text-amber-800",
  archived: "bg-rose-100 text-rose-800",
};

function unwrapList(r: unknown): PackageRow[] {
  // Backend envelope: { success, message, data: { packages: [...], count } }
  // requestJSON already unwraps `.data`, so `r` is `{ packages, count }`.
  const data = (r as { packages?: PackageRow[] })?.packages ?? r;
  return Array.isArray(data) ? data : [];
}

function paiseToRupees(minor: string | number | null | undefined): string {
  if (minor === null || minor === undefined || minor === "") return "";
  const n = Number(minor);
  if (!Number.isFinite(n)) return "";
  return (n / 100).toFixed(2);
}

function rupeesToPaise(rupees: string): number | null {
  const t = rupees.trim();
  if (!t) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function rowToForm(row: PackageRow): PackageFormState {
  return {
    id: row.id,
    package_code: row.package_code ?? "",
    display_name: row.display_name ?? "",
    description: row.description ?? "",
    base_specialty: row.base_specialty ?? "",
    base_procedure_code: row.base_procedure_code ?? "",
    duration_days: row.duration_days?.toString() ?? "",
    price_rupees: paiseToRupees(row.fixed_price_minor),
    currency: row.currency ?? "INR",
    status: row.status ?? "active",
    inclusion_notes: row.inclusion_notes ?? "",
    exclusion_notes: row.exclusion_notes ?? "",
  };
}

export default function PackagesPage() {
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<"" | PackageRow["status"]>(
    "",
  );
  const [form, setForm] = useState<PackageFormState | null>(null);

  const {
    data: rows = [],
    isLoading,
    error,
  } = useQuery<PackageRow[]>({
    queryKey: ["billing-masters", "packages", { statusFilter }],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (statusFilter) params.set("status", statusFilter);
      const r = await fetchAdminAPI<unknown>(
        `/admin/billing-masters/packages?${params.toString()}`,
      );
      return unwrapList(r);
    },
  });

  const upsertMut = useMutation({
    mutationFn: async (f: PackageFormState) => {
      const priceMinor = rupeesToPaise(f.price_rupees);
      const durationDays =
        f.duration_days.trim() === "" ? null : Number(f.duration_days);
      const body: Record<string, unknown> = {
        package_code: f.package_code.trim(),
        display_name: f.display_name.trim(),
        description: f.description.trim() || null,
        base_specialty: f.base_specialty.trim() || null,
        base_procedure_code: f.base_procedure_code.trim() || null,
        duration_days: Number.isFinite(durationDays as number)
          ? durationDays
          : null,
        fixed_price_minor: priceMinor,
        currency: (f.currency.trim() || "INR").toUpperCase(),
        status: f.status,
        inclusion_notes: f.inclusion_notes.trim() || null,
        exclusion_notes: f.exclusion_notes.trim() || null,
      };
      if (f.id !== null) body.id = f.id;
      return fetchAdminAPI("/admin/billing-masters/packages", {
        method: "PUT",
        body,
      });
    },
    onSuccess: () => {
      toast.success(form?.id ? "Package updated" : "Package created");
      setForm(null);
      qc.invalidateQueries({ queryKey: ["billing-masters", "packages"] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to save package";
      toast.error(msg);
    },
  });

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) =>
      a.display_name.localeCompare(b.display_name),
    );
  }, [rows]);

  function openCreate() {
    setForm({ ...EMPTY_FORM });
  }

  function openEdit(row: PackageRow) {
    setForm(rowToForm(row));
  }

  function submit() {
    if (!form) return;
    if (!form.package_code.trim()) {
      toast.error("Package code is required");
      return;
    }
    if (!form.display_name.trim()) {
      toast.error("Display name is required");
      return;
    }
    if (form.price_rupees.trim() && rupeesToPaise(form.price_rupees) === null) {
      toast.error("Price must be a non-negative number");
      return;
    }
    upsertMut.mutate(form);
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            Day-care & Surgical Packages
          </h1>
          <p className="text-muted-foreground mt-1">
            Bundled-price packages used at admission and billing. Prices are
            stored in paise; this form takes rupees and converts on save.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={statusFilter}
            onChange={(e) =>
              setStatusFilter(e.target.value as typeof statusFilter)
            }
            className="h-10 rounded-md border border-input bg-card px-3 text-sm"
          >
            <option value="">All statuses</option>
            <option value="active">Active</option>
            <option value="draft">Draft</option>
            <option value="paused">Paused</option>
            <option value="archived">Archived</option>
          </select>
          <button
            type="button"
            onClick={openCreate}
            className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-white hover:bg-primary/90"
          >
            + New package
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10">
          <LoadingSpinner />
        </div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-destructive">
          {error instanceof Error ? error.message : "Failed to load packages"}
        </div>
      ) : sortedRows.length === 0 ? (
        <EmptyState
          title="No packages yet"
          description="Create your first day-care package — admit screens auto-populate the deposit from the fixed price."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow">
          <table className="w-full min-w-[920px] divide-y divide-border">
            <thead className="bg-muted">
              <tr className="text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3">Code</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Specialty</th>
                <th className="px-4 py-3">Days</th>
                <th className="px-4 py-3 text-right">Price</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sortedRows.map((row) => (
                <tr key={row.id} className="hover:bg-muted/40">
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {row.package_code}
                  </td>
                  <td className="px-4 py-3 text-sm font-medium text-foreground">
                    {row.display_name}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {row.base_specialty ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {row.duration_days ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums text-foreground">
                    {row.fixed_price_minor === null ||
                    row.fixed_price_minor === undefined
                      ? "—"
                      : `${row.currency} ${paiseToRupees(row.fixed_price_minor)}`}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${STATUS_COLOURS[row.status]}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => openEdit(row)}
                      className="text-sm font-medium text-primary hover:underline"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form !== null && (
        <PackageFormModal
          form={form}
          onChange={setForm}
          onSubmit={submit}
          onCancel={() => setForm(null)}
          submitting={upsertMut.isPending}
        />
      )}
    </div>
  );
}

function PackageFormModal({
  form,
  onChange,
  onSubmit,
  onCancel,
  submitting,
}: {
  form: PackageFormState;
  onChange: (f: PackageFormState) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting: boolean;
}) {
  const isEdit = form.id !== null;

  function field<K extends keyof PackageFormState>(
    key: K,
    value: PackageFormState[K],
  ) {
    onChange({ ...form, [key]: value });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-xl font-bold text-foreground">
          {isEdit ? "Edit package" : "New package"}
        </h2>

        <form
          className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          <Field label="Package code" required>
            <input
              type="text"
              value={form.package_code}
              onChange={(e) => field("package_code", e.target.value)}
              placeholder="DC-CATARACT-PHACO"
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm font-mono"
              disabled={isEdit}
              required
            />
          </Field>
          <Field label="Display name" required>
            <input
              type="text"
              value={form.display_name}
              onChange={(e) => field("display_name", e.target.value)}
              placeholder="Cataract — Phacoemulsification + IOL (day-care)"
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
              required
            />
          </Field>

          <Field label="Base specialty">
            <input
              type="text"
              value={form.base_specialty}
              onChange={(e) => field("base_specialty", e.target.value)}
              placeholder="ophthalmology"
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
            />
          </Field>
          <Field label="Procedure code">
            <input
              type="text"
              value={form.base_procedure_code}
              onChange={(e) => field("base_procedure_code", e.target.value)}
              placeholder="PHACO_IOL"
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm font-mono"
            />
          </Field>

          <Field label="Duration (days)">
            <input
              type="number"
              min={0}
              step={1}
              value={form.duration_days}
              onChange={(e) => field("duration_days", e.target.value)}
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm tabular-nums"
            />
          </Field>
          <Field label={`Price (${form.currency})`}>
            <input
              type="number"
              min={0}
              step="0.01"
              value={form.price_rupees}
              onChange={(e) => field("price_rupees", e.target.value)}
              placeholder="15000.00"
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm tabular-nums"
            />
          </Field>

          <Field label="Currency">
            <input
              type="text"
              value={form.currency}
              onChange={(e) => field("currency", e.target.value.toUpperCase())}
              maxLength={8}
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm uppercase"
            />
          </Field>
          <Field label="Status">
            <select
              value={form.status}
              onChange={(e) =>
                field("status", e.target.value as PackageRow["status"])
              }
              className="h-10 w-full rounded-md border border-input bg-card px-3 text-sm"
            >
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
            </select>
          </Field>

          <div className="md:col-span-2">
            <Field label="Description">
              <textarea
                value={form.description}
                onChange={(e) => field("description", e.target.value)}
                rows={2}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field
              label="Inclusions"
              hint="What's bundled into the fixed price."
            >
              <textarea
                value={form.inclusion_notes}
                onChange={(e) => field("inclusion_notes", e.target.value)}
                rows={2}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <div className="md:col-span-2">
            <Field label="Exclusions" hint="What's billed separately on top.">
              <textarea
                value={form.exclusion_notes}
                onChange={(e) => field("exclusion_notes", e.target.value)}
                rows={2}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm"
              />
            </Field>
          </div>

          <div className="md:col-span-2 mt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="h-10 rounded-xl border border-input bg-card px-4 text-sm font-medium text-foreground hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="h-10 rounded-xl bg-primary px-4 text-sm font-medium text-white hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create package"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block text-sm font-medium text-foreground">
      <span>
        {label}
        {required && <span className="text-destructive"> *</span>}
      </span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </label>
  );
}
