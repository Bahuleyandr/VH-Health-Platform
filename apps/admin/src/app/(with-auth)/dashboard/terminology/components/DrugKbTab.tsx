"use client";

// Tab 4 — drug knowledge base: source registry (priority / license /
// governance), KB status, and (WP4) formulary match coverage. Source
// activation is an operator CLI action (drug-kb-import.mjs), so this tab is
// read-only.

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  getDrugKbCoverage,
  getDrugKbStatus,
} from "@/lib/api/terminologyAdmin";
import { useQuery } from "@tanstack/react-query";

import { formatCount, formatDate, OnOffPill, QueryErrorNotice, SectionCard } from "./shared";

export default function DrugKbTab() {
  const status = useQuery({
    queryKey: ["drug-kb", "status"],
    queryFn: () => getDrugKbStatus(),
  });
  const coverage = useQuery({
    queryKey: ["drug-kb", "coverage"],
    queryFn: () => getDrugKbCoverage(),
    retry: false,
  });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Knowledge base sources"
        description="Licensed vendor datasets are imported and activated operator-side (drug-kb-import.mjs). Deterministic matching stays dark while only the starter set is active."
      >
        {status.isLoading && <LoadingSpinner />}
        {status.isError && (
          <QueryErrorNotice
            error={status.error}
            notAvailableMessage="Drug KB status not available."
          />
        )}
        {status.data && (
          <>
            {status.data.starter_only === true && (
              <div className="mb-3 rounded border border-warning bg-warning/10 px-4 py-2 text-sm text-warning">
                Only the built-in starter set is active — procure and import a
                licensed KB before enabling any drug-KB gate.
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Vendor / version</th>
                    <th className="py-2 pr-4">Priority</th>
                    <th className="py-2 pr-4">License</th>
                    <th className="py-2 pr-4">Expiry</th>
                    <th className="py-2 pr-4">Imported</th>
                    <th className="py-2 pr-4">State</th>
                  </tr>
                </thead>
                <tbody>
                  {status.data.sources.map((source) => (
                    <tr key={source.source_key} className="border-b last:border-b-0">
                      <td className="py-2 pr-4 font-medium text-foreground">
                        {source.source_key}
                        {source.is_starter && (
                          <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                            starter
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground">
                        {[source.vendor, source.version]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </td>
                      <td className="py-2 pr-4">{source.priority ?? "—"}</td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">
                        {source.license_status ?? source.license_note ?? "—"}
                        {source.license_holder ? ` · ${source.license_holder}` : ""}
                      </td>
                      <td className="py-2 pr-4">
                        {formatDate(source.license_expires_at)}
                      </td>
                      <td className="py-2 pr-4">{formatDate(source.imported_at)}</td>
                      <td className="py-2 pr-4">
                        <OnOffPill on={source.is_active} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {status.data.counts && (
              <p className="mt-3 text-xs text-muted-foreground">
                Loaded:{" "}
                {Object.entries(status.data.counts)
                  .map(([key, value]) => `${key} ${formatCount(value)}`)
                  .join(" · ")}
              </p>
            )}
          </>
        )}
      </SectionCard>

      <SectionCard
        title="Formulary match coverage"
        description="Share of the pharmacy catalog deterministically resolvable to a KB drug key, per resolution tier."
      >
        {coverage.isLoading && <LoadingSpinner />}
        {coverage.isError && (
          <QueryErrorNotice
            error={coverage.error}
            notAvailableMessage="Formulary coverage endpoint not available yet (ships with the deterministic-matching work package)."
          />
        )}
        {coverage.data && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Catalog rows</div>
              <div className="text-lg font-semibold text-foreground">
                {formatCount(coverage.data.catalog_rows)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Matched</div>
              <div className="text-lg font-semibold text-foreground">
                {formatCount(coverage.data.matched)}
                {typeof coverage.data.matched_pct === "number"
                  ? ` (${coverage.data.matched_pct}%)`
                  : ""}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">By tier</div>
              <div className="text-xs text-foreground">
                {coverage.data.tiers
                  ? Object.entries(coverage.data.tiers)
                      .map(([tier, count]) => `${tier}: ${formatCount(count)}`)
                      .join(" · ")
                  : "—"}
              </div>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
