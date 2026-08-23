"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { APIError } from "@/lib/api/core";
import {
  downloadNabhPeriodPack,
  freezeNabhPeriodPack,
  getFrozenNabhPeriodPack,
  type NabhPeriod,
} from "@/lib/api/nabhPacks";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Braces, Download, FileText, Snowflake } from "lucide-react";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { SectionCard, formatDateTime } from "./shared";

function isNotFrozen(error: unknown) {
  return error instanceof APIError && error.status === 404;
}

/**
 * Frozen assessor pack for one period. Freezing snapshots every available
 * indicator (upserting the period's rows) and returns the assessor pack;
 * CSV/PDF exports read the frozen rows, never a live recomputation.
 */
export function PeriodPackPanel({ period }: { period: NabhPeriod }) {
  const queryClient = useQueryClient();
  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [showJson, setShowJson] = useState(false);

  const packQuery = useQuery({
    queryKey: ["nabh-period-pack", period.from, period.to],
    queryFn: () => getFrozenNabhPeriodPack(period),
    retry: false,
  });

  const freezeMutation = useMutation({
    mutationFn: () => freezeNabhPeriodPack(period),
    onSuccess: (pack) => {
      toast.success(
        `Period pack frozen — ${pack.snapshot_saved ?? 0} indicator snapshots saved`,
      );
      queryClient.setQueryData(
        ["nabh-period-pack", period.from, period.to],
        pack,
      );
      void queryClient.invalidateQueries({ queryKey: ["nabh-snapshots"] });
    },
    onError: (err: Error) => toast.error(err.message || "Freeze failed"),
  });

  const downloadMutation = useMutation({
    mutationFn: (format: "csv" | "pdf") =>
      downloadNabhPeriodPack(period, format),
    onError: (err: Error) => toast.error(err.message || "Export failed"),
  });

  const pack = packQuery.data;

  return (
    <SectionCard
      title={`Period Pack ${period.from} → ${period.to}`}
      icon={<Snowflake className="h-4 w-4" />}
      actions={
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setConfirmFreeze(true)}
            disabled={freezeMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          >
            <Snowflake className="h-4 w-4" />
            Freeze period pack
          </button>
          <button
            type="button"
            onClick={() => downloadMutation.mutate("csv")}
            disabled={!pack || downloadMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            CSV
          </button>
          <button
            type="button"
            onClick={() => downloadMutation.mutate("pdf")}
            disabled={!pack || downloadMutation.isPending}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
          >
            <FileText className="h-4 w-4" />
            PDF
          </button>
          <button
            type="button"
            onClick={() => setShowJson((current) => !current)}
            disabled={!pack}
            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground disabled:opacity-50"
          >
            <Braces className="h-4 w-4" />
            {showJson ? "Hide JSON" : "View JSON"}
          </button>
        </div>
      }
    >
      {packQuery.isLoading && <LoadingSpinner label="Checking frozen pack…" />}

      {packQuery.error && isNotFrozen(packQuery.error) && (
        <EmptyState
          compact
          title="Not frozen yet"
          description="No pack has been frozen for this period. Freeze it to snapshot the current indicator values as assessor evidence."
        />
      )}
      {packQuery.error instanceof Error && !isNotFrozen(packQuery.error) && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {packQuery.error.message}
        </div>
      )}

      {pack && (
        <div className="space-y-3">
          <dl className="grid gap-3 text-sm md:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Frozen at</dt>
              <dd className="font-medium text-foreground">
                {formatDateTime(pack.frozen_at)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Indicators</dt>
              <dd className="font-medium text-foreground">
                {pack.indicator_count} of {pack.expected_indicator_count}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Assessor format</dt>
              <dd className="font-medium text-foreground">
                {pack.export_contract.canonical_format_status}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Evidence control</dt>
              <dd className="font-mono text-xs text-foreground">
                {pack.evidence_attachment.control_code} ·{" "}
                {pack.evidence_attachment.status}
              </dd>
            </div>
          </dl>
          {pack.missing_indicator_codes.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Missing from this frozen pack:{" "}
              {pack.missing_indicator_codes.join(", ")}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            {pack.export_contract.phi_policy}
          </p>
          {showJson && (
            <div className="overflow-x-auto rounded-md border border-border bg-muted/30 p-3">
              <pre className="text-xs">{JSON.stringify(pack, null, 2)}</pre>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmFreeze}
        setOpen={setConfirmFreeze}
        title={`Freeze pack for ${period.from} → ${period.to}?`}
        message="Freezing snapshots the current indicator values as assessor evidence. Re-freezing the same period overwrites its previously frozen values."
        confirmLabel="Freeze pack"
        variant="destructive"
        onConfirm={() => freezeMutation.mutate()}
      />
    </SectionCard>
  );
}
