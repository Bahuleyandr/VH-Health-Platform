"use client";

import type { ReactNode } from "react";

export const inputClass =
  "rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground";

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
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
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

export function AvailabilityPill({ available }: { available: boolean }) {
  return (
    <span
      className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${
        available
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-amber-200 bg-amber-50 text-amber-800"
      }`}
    >
      {available ? "available" : "unavailable"}
    </span>
  );
}

export function formatIndicatorValue(
  value: number | null,
  unit: string | null,
) {
  if (value == null) return "n/a";
  return unit ? `${value} ${unit}` : String(value);
}

export function formatCount(value: number | null) {
  return value == null ? "n/a" : String(value);
}

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
