"use client";

// Shared presentation + form primitives for the CSSD console. Split out of the
// old single-file page per the admin god-page rule (apps/admin/CLAUDE.md).

import { X } from "lucide-react";
import type { ReactNode } from "react";

const STATUS_TONE: Record<string, string> = {
  available: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  sterilized: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  issued: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  in_theatre: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  returned: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  decontamination: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  awaiting_sterilization:
    "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  sterilization_pending:
    "bg-purple-500/15 text-purple-700 dark:text-purple-300",
  sterilization_failed: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  unusable: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  retired: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  passed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  completed: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  cancelled: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
  planned: "bg-muted text-muted-foreground",
};

export function fmtDate(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function statusTone(status?: string) {
  return (
    STATUS_TONE[String(status || "").toLowerCase()] ??
    "bg-muted text-muted-foreground"
  );
}

export function humanize(value?: string) {
  return String(value || "").replace(/_/g, " ");
}

export function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error && err.message ? err.message : fallback;
}

/** Local YYYY-MM-DD — GET /theatre/today filters on a DATE column. */
export function todayIso() {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

export function StatusPill({ status }: { status?: string }) {
  return (
    <span className={`rounded px-2 py-1 text-xs ${statusTone(status)}`}>
      {humanize(status)}
    </span>
  );
}

export function Kpi({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneClass =
    tone === "good"
      ? "border-emerald-500/30 bg-emerald-500/5"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/5"
        : tone === "bad"
          ? "border-rose-500/30 bg-rose-500/5"
          : "border-border bg-card";
  return (
    <div className={`rounded-lg border p-4 ${toneClass}`}>
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 text-3xl font-semibold">{value}</div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        className={`max-h-[90vh] w-full overflow-y-auto rounded-xl border border-border bg-card p-6 shadow-xl ${wide ? "max-w-2xl" : "max-w-md"}`}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close dialog">
            <X className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
        <div className="space-y-3">{children}</div>
        {footer && <div className="mt-5 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";

export function DialogError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-700 dark:text-rose-300">
      {message}
    </div>
  );
}
