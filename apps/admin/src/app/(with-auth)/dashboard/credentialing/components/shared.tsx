import type {
  AlertSeverity,
  CatalogStatus,
  CredentialStatus,
  CredentialType,
} from "./types";

const STATUS_STYLES: Record<CredentialStatus | CatalogStatus, string> = {
  active: "border-emerald-200 bg-emerald-50 text-emerald-700",
  suspended: "border-amber-200 bg-amber-50 text-amber-800",
  revoked: "border-rose-200 bg-rose-50 text-rose-700",
  paused: "border-amber-200 bg-amber-50 text-amber-800",
  retired: "border-slate-200 bg-slate-100 text-slate-600",
};

const TYPE_STYLES: Record<CredentialType, string> = {
  registration: "border-blue-200 bg-blue-50 text-blue-700",
  qualification: "border-indigo-200 bg-indigo-50 text-indigo-700",
  privilege: "border-emerald-200 bg-emerald-50 text-emerald-700",
  training: "border-cyan-200 bg-cyan-50 text-cyan-700",
  immunization: "border-violet-200 bg-violet-50 text-violet-700",
};

const SEVERITY_STYLES: Record<AlertSeverity, string> = {
  low: "border-slate-200 bg-slate-50 text-slate-700",
  medium: "border-amber-200 bg-amber-50 text-amber-800",
  high: "border-orange-200 bg-orange-50 text-orange-800",
  critical: "border-rose-200 bg-rose-50 text-rose-700",
};

export function formatDate(value?: string | null) {
  if (!value) return "-";
  return String(value).slice(0, 10);
}

export function humanize(value?: string | null) {
  if (!value) return "-";
  return value.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

export function StatusBadge({ status }: { status: CredentialStatus | CatalogStatus }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {humanize(status)}
    </span>
  );
}

export function TypeBadge({ type }: { type: CredentialType }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${TYPE_STYLES[type]}`}>
      {humanize(type)}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: AlertSeverity }) {
  return (
    <span className={`inline-flex rounded border px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[severity]}`}>
      {humanize(severity)}
    </span>
  );
}

export function StatCard({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string | number;
  tone?: "default" | "amber" | "rose" | "emerald";
}) {
  const toneClass =
    tone === "amber"
      ? "border-amber-200"
      : tone === "rose"
        ? "border-rose-200"
        : tone === "emerald"
          ? "border-emerald-200"
          : "";
  return (
    <div className={`rounded-lg border bg-card p-3 shadow-sm ${toneClass}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold text-foreground">{value}</p>
    </div>
  );
}
