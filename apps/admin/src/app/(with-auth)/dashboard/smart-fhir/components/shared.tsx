"use client";

// Shared UI primitives for the SMART-on-FHIR console.

export function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "-";
  return parsed.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const PILL_STYLES: Record<string, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-800",
  production_approved: "border-emerald-200 bg-emerald-50 text-emerald-800",
  sandbox_approved: "border-emerald-200 bg-emerald-50 text-emerald-800",
  paused: "border-amber-200 bg-amber-50 text-amber-800",
  production_pending: "border-amber-200 bg-amber-50 text-amber-800",
  sandbox_pending: "border-amber-200 bg-amber-50 text-amber-800",
  expired: "border-slate-200 bg-slate-50 text-slate-700",
  rotated: "border-slate-200 bg-slate-50 text-slate-700",
  revoked: "border-red-200 bg-red-50 text-red-800",
  rejected: "border-red-200 bg-red-50 text-red-800",
  archived: "border-slate-200 bg-slate-50 text-slate-700",
};

export function StatusPill({ value }: { value: string }) {
  const color =
    PILL_STYLES[value] ?? "border-slate-200 bg-slate-50 text-slate-700";
  return (
    <span
      className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function ScopeChips({
  scopes,
  max = 3,
}: {
  scopes: string[];
  max?: number;
}) {
  if (!scopes.length)
    return <span className="text-xs text-muted-foreground">-</span>;
  const shown = scopes.slice(0, max);
  const rest = scopes.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1" title={scopes.join(" ")}>
      {shown.map((scope) => (
        <code
          key={scope}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        >
          {scope}
        </code>
      ))}
      {rest > 0 && (
        <span className="text-[11px] text-muted-foreground">+{rest} more</span>
      )}
    </span>
  );
}

export function ErrorBanner({
  message,
  code,
  requestId,
}: {
  message: string;
  code?: string | null;
  requestId?: string | null;
}) {
  return (
    <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
      <span>{message}</span>
      {code && (
        <code className="ml-2 rounded bg-red-100 px-1.5 py-0.5 font-mono text-xs">
          {code}
        </code>
      )}
      {requestId && (
        <span className="ml-2 text-xs text-red-500">request {requestId}</span>
      )}
    </div>
  );
}
