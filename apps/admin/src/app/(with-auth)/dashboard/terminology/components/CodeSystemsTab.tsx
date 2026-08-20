"use client";

// Tab 1 — code-system registry + import provenance + binding coverage.
// Read-only: imports happen operator-side via
// apps/backend/scripts/terminology-import.mjs (see
// docs/TERMINOLOGY_DRUG_KB_ENABLEMENT.md).

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  getTerminologyCoverage,
  listTerminologyCodeSystems,
} from "@/lib/api/terminologyAdmin";
import { useQuery } from "@tanstack/react-query";

import { formatCount, formatDate, OnOffPill, QueryErrorNotice, SectionCard } from "./shared";

export default function CodeSystemsTab() {
  const systems = useQuery({
    queryKey: ["terminology", "code-systems"],
    queryFn: () => listTerminologyCodeSystems(),
  });
  const coverage = useQuery({
    queryKey: ["terminology", "coverage"],
    queryFn: () => getTerminologyCoverage(),
  });

  return (
    <div className="space-y-6">
      <SectionCard
        title="Registered code systems"
        description="Concept counts and import provenance per system. Content is imported operator-side (terminology-import.mjs) from officially licensed release files — the repository ships none."
      >
        {systems.isLoading && <LoadingSpinner />}
        {systems.isError && (
          <QueryErrorNotice
            error={systems.error}
            notAvailableMessage="Terminology service not reachable."
          />
        )}
        {systems.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-4">System</th>
                  <th className="py-2 pr-4">Version</th>
                  <th className="py-2 pr-4">Concepts</th>
                  <th className="py-2 pr-4">Imported</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2 pr-4">License</th>
                </tr>
              </thead>
              <tbody>
                {systems.data.systems.map((system) => (
                  <tr key={system.system_key} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 font-medium text-foreground">
                      {system.system_key}
                      <div className="text-xs font-normal text-muted-foreground">
                        {system.name ?? ""}
                      </div>
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {system.version ?? "—"}
                    </td>
                    <td className="py-2 pr-4">{formatCount(system.concept_count)}</td>
                    <td className="py-2 pr-4">{formatDate(system.imported_at)}</td>
                    <td className="py-2 pr-4">
                      <OnOffPill on={system.is_active} />
                    </td>
                    <td className="max-w-md py-2 pr-4 text-xs text-muted-foreground">
                      {system.license_note ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Catalog binding coverage"
        description="How much of each local catalog carries a confirmed standard-code binding."
      >
        {coverage.isLoading && <LoadingSpinner />}
        {coverage.isError && (
          <QueryErrorNotice
            error={coverage.error}
            notAvailableMessage="Coverage report not available."
          />
        )}
        {coverage.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-4">Catalog</th>
                  <th className="py-2 pr-4">Default system</th>
                  <th className="py-2 pr-4">Rows</th>
                  <th className="py-2 pr-4">Confirmed</th>
                  <th className="py-2 pr-4">Suggested</th>
                  <th className="py-2 pr-4">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {coverage.data.coverage.catalog_bindings.map((row) => (
                  <tr key={row.catalog_type} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 text-foreground">{row.catalog_type}</td>
                    <td className="py-2 pr-4">{row.default_system}</td>
                    <td className="py-2 pr-4">{formatCount(row.catalog_rows)}</td>
                    <td className="py-2 pr-4">{formatCount(row.confirmed)}</td>
                    <td className="py-2 pr-4">{formatCount(row.suggested)}</td>
                    <td className="py-2 pr-4">{row.confirmed_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
