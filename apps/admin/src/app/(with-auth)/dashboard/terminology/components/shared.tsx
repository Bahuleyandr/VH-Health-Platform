"use client";

// Shared primitives for the Terminology & Knowledge console tabs.

import { isNotFoundError } from "@/lib/api/terminologyAdmin";

export function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg bg-card p-6 shadow">
      <h2 className="mb-1 text-lg font-medium text-foreground">{title}</h2>
      {description && (
        <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      )}
      {children}
    </div>
  );
}

export function OnOffPill({ on, label }: { on: boolean; label?: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        on ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"
      }`}
    >
      {label ?? (on ? "active" : "inactive")}
    </span>
  );
}

/**
 * Degrade seam for tabs backed by sibling-work-package endpoints: a 404
 * means the feature is not merged/served yet, which is an expected state of
 * this dark-shipped console — not an error.
 */
export function QueryErrorNotice({
  error,
  notAvailableMessage,
}: {
  error: unknown;
  notAvailableMessage: string;
}) {
  if (isNotFoundError(error)) {
    return (
      <div className="rounded border border-input bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        {notAvailableMessage}
      </div>
    );
  }
  return (
    <div className="rounded border border-destructive bg-destructive/10 px-4 py-3 text-destructive">
      {error instanceof Error ? error.message : "Request failed"}
    </div>
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export function formatCount(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString()
    : "—";
}
