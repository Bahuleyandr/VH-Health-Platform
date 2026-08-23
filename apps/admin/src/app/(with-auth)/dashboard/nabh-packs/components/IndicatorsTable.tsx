"use client";

import type { NabhIndicator } from "@/lib/api/nabhPacks";
import { Gauge } from "lucide-react";

import {
  AvailabilityPill,
  SectionCard,
  formatCount,
  formatIndicatorValue,
} from "./shared";

/**
 * Read-only summary of the computed NABH indicator set. Unavailable rows are
 * a first-class state — the backend reports a missing source table or a
 * failed computation per indicator instead of failing the whole pack.
 */
export function IndicatorsTable({
  indicators,
}: {
  indicators: NabhIndicator[];
}) {
  return (
    <SectionCard
      title={`Indicators (${indicators.length})`}
      icon={<Gauge className="h-4 w-4" />}
    >
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2">Chapter</th>
              <th className="px-3 py-2">Indicator</th>
              <th className="px-3 py-2">Value</th>
              <th className="px-3 py-2">Num / Den</th>
              <th className="px-3 py-2">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {indicators.map((indicator) => (
              <tr key={indicator.code}>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {indicator.definition?.chapter ?? "—"}
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-foreground">
                    {indicator.label}
                  </div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {indicator.code}
                  </div>
                </td>
                <td className="px-3 py-2 font-medium text-foreground">
                  {formatIndicatorValue(indicator.value, indicator.unit)}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {formatCount(indicator.numerator)} /{" "}
                  {formatCount(indicator.denominator)}
                </td>
                <td className="px-3 py-2">
                  <AvailabilityPill available={indicator.available} />
                  {!indicator.available && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {String(indicator.details?.error ?? "")}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
