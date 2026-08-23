"use client";

import type { ReactNode } from "react";

export function StatusPill({ value }: { value: string }) {
  const color =
    value === "report_ready" || value === "committed" || value === "active"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : value === "blocked" ||
          value === "failed" ||
          value === "conflict" ||
          value === "error"
        ? "border-red-200 bg-red-50 text-red-700"
        : "border-amber-200 bg-amber-50 text-amber-800";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function formatDateTime(value?: string | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SectionCard({
  title,
  actions,
  children,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/** Render a labelled map of counters (e.g. by_severity, by_code). */
export function CountGrid({
  entries,
}: {
  entries: Record<string, number>;
}) {
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return <p className="text-sm text-muted-foreground">None</p>;
  }
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {keys.map((key) => (
        <div key={key} className="rounded-md border border-border bg-background px-3 py-2">
          <dt className="text-xs text-muted-foreground">{key.replace(/_/g, " ")}</dt>
          <dd className="text-lg font-semibold text-foreground">{entries[key]}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Honest raw rendering for API-returned report objects: the toolkit responses
 * are PHI-redacted server-side, so we display exactly what the API returned
 * instead of synthesizing a prettier (and potentially misleading) summary.
 */
export function JsonDetails({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  return (
    <details className="rounded-md border border-border bg-background">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
        {label}
      </summary>
      <div className="overflow-x-auto border-t border-border px-3 py-2">
        <pre className="text-xs text-foreground">
          {JSON.stringify(value ?? null, null, 2)}
        </pre>
      </div>
    </details>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  pending,
  onConfirm,
  onCancel,
  destructive = false,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  destructive?: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl">
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <div className="mt-2 space-y-2 text-sm text-muted-foreground">{body}</div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={`rounded-md px-3 py-2 text-sm font-medium text-white disabled:opacity-60 ${
              destructive ? "bg-red-600 hover:bg-red-700" : "bg-primary"
            }`}
          >
            {pending ? "Working..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
