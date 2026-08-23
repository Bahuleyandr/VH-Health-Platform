"use client";

import { EmptyState } from "@/components/EmptyState";
import { LoadingSpinner } from "@/components/LoadingSpinner";
import { listNabhSnapshots } from "@/lib/api/nabhPacks";
import { useQuery } from "@tanstack/react-query";
import { Camera } from "lucide-react";

import {
  SectionCard,
  formatCount,
  formatDateTime,
  formatIndicatorValue,
} from "./shared";

/** Read-only ledger of persisted indicator snapshots across all periods. */
export function SnapshotsTable() {
  const snapshotsQuery = useQuery({
    queryKey: ["nabh-snapshots"],
    queryFn: () => listNabhSnapshots(),
  });

  return (
    <SectionCard
      title={`Snapshots${
        snapshotsQuery.data ? ` (${snapshotsQuery.data.count})` : ""
      }`}
      icon={<Camera className="h-4 w-4" />}
    >
      {snapshotsQuery.isLoading && (
        <LoadingSpinner label="Loading snapshots…" />
      )}
      {snapshotsQuery.error instanceof Error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          {snapshotsQuery.error.message}
        </div>
      )}
      {snapshotsQuery.data &&
        (snapshotsQuery.data.snapshots.length === 0 ? (
          <EmptyState
            compact
            title="No snapshots recorded"
            description="Freezing a period pack persists one snapshot row per available indicator."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">Period</th>
                  <th className="px-3 py-2">Indicator</th>
                  <th className="px-3 py-2">Value</th>
                  <th className="px-3 py-2">Num / Den</th>
                  <th className="px-3 py-2">Computed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {snapshotsQuery.data.snapshots.map((row) => (
                  <tr
                    key={`${row.period_start}:${row.period_end}:${row.indicator_code}`}
                  >
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {String(row.period_start).slice(0, 10)} →{" "}
                      {String(row.period_end).slice(0, 10)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium text-foreground">
                        {row.label}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {row.indicator_code}
                      </div>
                    </td>
                    <td className="px-3 py-2 font-medium text-foreground">
                      {formatIndicatorValue(row.value, row.unit)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {formatCount(row.numerator)} /{" "}
                      {formatCount(row.denominator)}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {formatDateTime(row.computed_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </SectionCard>
  );
}
