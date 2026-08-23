"use client";

import type { EngagementCampaignStatus } from "@/lib/api/engagement";
import type { ReactNode } from "react";

/** Ordered authoring pipeline the backend enforces. */
export const CAMPAIGN_PIPELINE: Array<{
  status: EngagementCampaignStatus;
  label: string;
}> = [
  { status: "draft", label: "Draft" },
  { status: "dry_run", label: "Dry run" },
  { status: "pending_approval", label: "Pending approval" },
  { status: "scheduled", label: "Approved" },
  { status: "running", label: "Running" },
];

const STATUS_STYLES: Record<string, string> = {
  draft: "border-slate-200 bg-slate-50 text-slate-700",
  dry_run: "border-sky-200 bg-sky-50 text-sky-800",
  pending_approval: "border-amber-200 bg-amber-50 text-amber-800",
  scheduled: "border-emerald-200 bg-emerald-50 text-emerald-800",
  running: "border-teal-200 bg-teal-50 text-teal-800",
  paused: "border-amber-200 bg-amber-50 text-amber-800",
  completed: "border-emerald-200 bg-emerald-50 text-emerald-800",
  archived: "border-slate-200 bg-slate-50 text-slate-500",
  cancelled: "border-red-200 bg-red-50 text-red-700",
  eligible: "border-emerald-200 bg-emerald-50 text-emerald-800",
  suppressed: "border-amber-200 bg-amber-50 text-amber-800",
  queued: "border-sky-200 bg-sky-50 text-sky-800",
  sent: "border-emerald-200 bg-emerald-50 text-emerald-800",
  failed: "border-red-200 bg-red-50 text-red-700",
};

export function StatusPill({ value }: { value: string }) {
  const style = STATUS_STYLES[value] ?? "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function SectionCard({
  title,
  icon,
  actions,
  children,
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          {icon}
          {title}
        </div>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function FieldLabel({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground";

export function formatDateTime(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
