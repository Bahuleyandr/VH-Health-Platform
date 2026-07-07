import type { ComponentType, ReactNode, SVGProps } from "react";
import type {
  AnalyzerStatus,
  CareTeamKind,
  CareTeamMemberStatus,
  CareTeamStatus,
  QcResultStatus,
  SpecimenStatus,
} from "@/lib/api/clinicalGovernance";

export const CARE_TEAM_KINDS: CareTeamKind[] = [
  "op",
  "ip",
  "er",
  "icu",
  "day_care",
  "dialysis",
  "perioperative",
  "longitudinal",
  "other",
];
export const CARE_TEAM_STATUSES: CareTeamStatus[] = ["active", "paused", "closed", "archived"];
export const MEMBER_STATUSES: CareTeamMemberStatus[] = ["active", "inactive", "suspended", "ended"];
export const SPECIMEN_STATUSES: SpecimenStatus[] = [
  "ordered",
  "collected",
  "in_transit",
  "received",
  "processing",
  "rejected",
  "disposed",
  "cancelled",
];
export const ANALYZER_STATUSES: AnalyzerStatus[] = ["active", "maintenance", "offline", "retired"];
export const QC_STATUSES: QcResultStatus[] = ["pending", "passed", "failed", "warning"];
export const RELATIONSHIP_KINDS = [
  "primary_consultant",
  "attending_doctor",
  "covering_doctor",
  "resident",
  "nurse",
  "pharmacist",
  "physiotherapist",
  "billing_counsellor",
  "care_coordinator",
  "diagnostics",
  "housekeeping",
  "care_team",
  "other",
];

export function fmt(value?: string | null) {
  if (!value) return "-";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortUid(value?: string | null) {
  if (!value) return "-";
  return value.length > 12 ? `${value.slice(0, 8)}...${value.slice(-4)}` : value;
}

function statusPillClass(status: string) {
  switch (status) {
    case "active":
    case "passed":
    case "allow":
    case "received":
      return "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200";
    case "warning":
    case "paused":
    case "processing":
    case "collected":
    case "in_transit":
    case "pending":
    case "maintenance":
      return "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200";
    case "failed":
    case "denied":
    case "rejected":
    case "revoked":
      return "border-rose-300 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200";
    case "closed":
    case "ended":
    case "archived":
    case "disposed":
    case "cancelled":
    case "retired":
      return "border-slate-300 bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
      {message}
    </div>
  );
}

export function Pill({ value }: { value: string }) {
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusPillClass(value)}`}>
      {value}
    </span>
  );
}

export function SectionCard({
  title,
  icon: Icon,
  children,
  action,
}: {
  title: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="rounded-md border border-border bg-card p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Icon className="h-4 w-4 text-primary" />
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
