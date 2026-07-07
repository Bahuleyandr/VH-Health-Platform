"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { listCatalog, saveCatalogEntry } from "./api";
import { StatusBadge, humanize } from "./shared";
import type { CatalogStatus, PrivilegeCatalogEntry } from "./types";

const STATUS_OPTIONS: CatalogStatus[] = ["active", "paused", "retired"];

function blankForm() {
  return {
    id: "",
    privilege_key: "",
    display_name: "",
    description: "",
    required_credential_types: "",
    review_cadence_days: "365",
    enforcement_scope: "",
    status: "active" as CatalogStatus,
  };
}

export function CatalogTab() {
  const qc = useQueryClient();
  const [form, setForm] = useState(blankForm);
  const { data, isLoading, error } = useQuery({
    queryKey: ["credentialing", "catalog"],
    queryFn: listCatalog,
  });
  const catalog = useMemo(() => data?.catalog ?? [], [data?.catalog]);

  const saveMut = useMutation({
    mutationFn: () =>
      saveCatalogEntry({
        id: form.id ? Number(form.id) : undefined,
        privilege_key: form.privilege_key,
        display_name: form.display_name,
        description: form.description,
        required_credential_types: form.required_credential_types
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
        review_cadence_days: Number(form.review_cadence_days || 365),
        enforcement_scope: form.enforcement_scope || null,
        status: form.status,
      }),
    onSuccess: () => {
      setForm(blankForm());
      void qc.invalidateQueries({ queryKey: ["credentialing", "catalog"] });
    },
  });

  function edit(row: PrivilegeCatalogEntry) {
    setForm({
      id: String(row.id),
      privilege_key: row.privilege_key,
      display_name: row.display_name,
      description: row.description ?? "",
      required_credential_types: (row.required_credential_types ?? []).join(", "),
      review_cadence_days: String(row.review_cadence_days ?? 365),
      enforcement_scope: row.enforcement_scope ?? "",
      status: row.status,
    });
  }

  useEffect(() => {
    if (!form.privilege_key && form.display_name) {
      setForm((current) => ({
        ...current,
        privilege_key: current.display_name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, ""),
      }));
    }
  }, [form.display_name, form.privilege_key]);

  const errMsg = (error ?? saveMut.error)?.toString() ?? null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-lg border bg-card shadow-sm">
        <div className="border-b px-4 py-3">
          <h2 className="text-lg font-semibold">Privilege catalog</h2>
        </div>
        {isLoading ? (
          <LoadingSpinner label="Loading catalog" />
        ) : catalog.length === 0 ? (
          <EmptyState title="No privileges" compact />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Privilege</th>
                  <th className="px-3 py-2">Scope</th>
                  <th className="px-3 py-2">Cadence</th>
                  <th className="px-3 py-2">Required credentials</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {catalog.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-3 py-2">
                      <div className="font-medium">{row.display_name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {row.privilege_key}
                      </div>
                    </td>
                    <td className="px-3 py-2">{humanize(row.enforcement_scope)}</td>
                    <td className="px-3 py-2 font-mono">{row.review_cadence_days}d</td>
                    <td className="px-3 py-2 text-xs">
                      {(row.required_credential_types ?? []).join(", ") || "-"}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={row.status} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => edit(row)}
                        className="rounded border px-2 py-1 text-xs hover:bg-muted"
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
      </div>

      <form
        className="rounded-lg border bg-card p-4 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          saveMut.mutate();
        }}
      >
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">
            {form.id ? "Edit privilege" : "Add privilege"}
          </h2>
          {form.id && (
            <button
              type="button"
              onClick={() => setForm(blankForm())}
              className="rounded border px-2 py-1 text-xs hover:bg-muted"
            >
              Clear
            </button>
          )}
        </div>
        {errMsg && (
          <div className="mb-3 rounded border border-destructive/30 bg-destructive/5 p-2 text-sm text-destructive">
            {errMsg}
          </div>
        )}
        <div className="space-y-3">
          <label className="block text-sm">
            <span className="text-xs font-medium text-muted-foreground">Display name</span>
            <input
              value={form.display_name}
              onChange={(event) => setForm({ ...form, display_name: event.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs font-medium text-muted-foreground">Privilege key</span>
            <input
              value={form.privilege_key}
              onChange={(event) => setForm({ ...form, privilege_key: event.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2 font-mono text-xs"
              required
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs font-medium text-muted-foreground">Description</span>
            <textarea
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              className="mt-1 min-h-20 w-full rounded-md border bg-background px-3 py-2"
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">
              <span className="text-xs font-medium text-muted-foreground">Cadence days</span>
              <input
                type="number"
                min={1}
                max={3650}
                value={form.review_cadence_days}
                onChange={(event) => setForm({ ...form, review_cadence_days: event.target.value })}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              />
            </label>
            <label className="block text-sm">
              <span className="text-xs font-medium text-muted-foreground">Status</span>
              <select
                value={form.status}
                onChange={(event) => setForm({ ...form, status: event.target.value as CatalogStatus })}
                className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              >
                {STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {humanize(status)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-xs font-medium text-muted-foreground">Scope</span>
            <input
              value={form.enforcement_scope}
              onChange={(event) => setForm({ ...form, enforcement_scope: event.target.value })}
              className="mt-1 w-full rounded-md border bg-background px-3 py-2"
            />
          </label>
          <label className="block text-sm">
            <span className="text-xs font-medium text-muted-foreground">Required credentials</span>
            <input
              value={form.required_credential_types}
              onChange={(event) =>
                setForm({ ...form, required_credential_types: event.target.value })
              }
              className="mt-1 w-full rounded-md border bg-background px-3 py-2"
              placeholder="registration, training"
            />
          </label>
          <button
            type="submit"
            disabled={saveMut.isPending}
            className="w-full rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
          >
            {saveMut.isPending ? "Saving..." : "Save privilege"}
          </button>
        </div>
      </form>
    </div>
  );
}
