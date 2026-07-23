"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";

import { LoadingSpinner } from "@/components/LoadingSpinner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getCarePathwayReconciliationEvidence,
  type CarePathwayEvidence,
} from "@/lib/api/carePathways";

const PATHWAY_LABELS: Record<string, string> = {
  diagnostics_order_to_action: "Diagnostics",
  referral_request_to_closure: "Referrals",
  op_contact_to_recovery: "Outpatient",
  inpatient_admission_to_recovery: "Inpatient",
  emergency_arrival_to_aftercare: "Emergency",
  surgery_decision_to_recovery: "Surgery",
};

function statusLabel(row: CarePathwayEvidence) {
  if (row.passed) return "Clean shadow evidence";
  if (row.error_count > 0) return "Technical error";
  if (!row.registry_complete) return "Adapter incomplete";
  return "Findings need review";
}

function EvidenceCard({ row }: { row: CarePathwayEvidence }) {
  const clean = row.passed;
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">
              {PATHWAY_LABELS[row.pathway_key] ?? row.pathway_key}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Mode: {row.pathway_mode} · Registry v{row.registry_version}
            </p>
          </div>
          {clean ? (
            <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-label="Clean" />
          ) : (
            <ShieldAlert className="h-5 w-5 text-amber-600" aria-label="Needs review" />
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm font-medium text-foreground">{statusLabel(row)}</p>
        <dl className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-md bg-muted/50 p-2">
            <dt className="text-muted-foreground">Findings</dt>
            <dd className="mt-1 text-base font-semibold">{row.finding_count}</dd>
          </div>
          <div className="rounded-md bg-muted/50 p-2">
            <dt className="text-muted-foreground">Repairs</dt>
            <dd className="mt-1 text-base font-semibold">{row.repair_count}</dd>
          </div>
          <div className="rounded-md bg-muted/50 p-2">
            <dt className="text-muted-foreground">Errors</dt>
            <dd className="mt-1 text-base font-semibold">{row.error_count}</dd>
          </div>
        </dl>
        {row.check_results.some(
          (result) => result.finding_count + result.repair_count + result.error_count > 0,
        ) ? (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {row.check_results
              .filter(
                (result) =>
                  result.finding_count + result.repair_count + result.error_count > 0,
              )
              .map((result) => (
                <li key={result.code} className="rounded border border-border px-2 py-1.5">
                  {result.code}: {result.finding_count} finding(s), {result.error_count} error(s)
                </li>
              ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Observed {new Date(row.completed_at).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  );
}

export default function CarePathwaysPage() {
  const [view, setView] = useState<"latest" | "history">("latest");
  const query = useQuery({
    queryKey: ["care-pathway-reconciliation", view],
    queryFn: () => getCarePathwayReconciliationEvidence(view),
  });

  return (
    <div className="space-y-5 p-4 lg:p-6">
      <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="h-6 w-6 text-primary" />
            <h1 className="text-2xl font-semibold text-foreground">Care Pathway Evidence</h1>
          </div>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Read-only shadow reconciliation evidence. A clean row supports owner review; it never activates a pathway.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={view === "latest" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("latest")}
          >
            Latest
          </Button>
          <Button
            variant={view === "history" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("history")}
          >
            History
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
          >
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </header>

      {query.isLoading ? <LoadingSpinner label="Loading pathway evidence…" /> : null}
      {query.isError ? (
        <div role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          Care pathway evidence could not be loaded.
        </div>
      ) : null}
      {query.data?.evidence.length === 0 ? (
        <div className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          No reconciliation evidence has been collected for this tenant yet.
        </div>
      ) : null}
      {query.data?.evidence.length ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {query.data.evidence.map((row) => (
            <EvidenceCard key={row.id} row={row} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
