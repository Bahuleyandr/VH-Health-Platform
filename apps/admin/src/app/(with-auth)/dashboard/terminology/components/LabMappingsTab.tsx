"use client";

// Tab 5 — lab analyzer-code → LOINC mappings (WP3 endpoints). Lists the
// per-tenant mapping table, offers a minimal create form, and shows the
// mapping coverage report. Degrades to a "not available yet" notice while
// the sibling work package is unmerged (404).

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  createLabCodeMapping,
  getLabCodeMappingCoverage,
  isNotFoundError,
  listLabCodeMappings,
} from "@/lib/api/terminologyAdmin";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { formatCount, OnOffPill, QueryErrorNotice, SectionCard } from "./shared";

export default function LabMappingsTab() {
  const queryClient = useQueryClient();
  const mappings = useQuery({
    queryKey: ["lab-code-mappings"],
    queryFn: () => listLabCodeMappings(),
    retry: false,
  });
  const coverage = useQuery({
    queryKey: ["lab-code-mappings", "coverage"],
    queryFn: () => getLabCodeMappingCoverage(),
    retry: false,
  });

  const [form, setForm] = useState({
    source_key: "any",
    incoming_code: "",
    loinc_code: "",
    display: "",
  });

  const create = useMutation({
    mutationFn: () =>
      createLabCodeMapping({
        source_key: form.source_key || "any",
        incoming_code: form.incoming_code,
        loinc_code: form.loinc_code || null,
        display: form.display || null,
        active: true,
      }),
    onSuccess: () => {
      toast.success("Mapping saved");
      setForm({ source_key: "any", incoming_code: "", loinc_code: "", display: "" });
      void queryClient.invalidateQueries({ queryKey: ["lab-code-mappings"] });
    },
    onError: (e) =>
      toast.error(
        isNotFoundError(e)
          ? "Lab code-mapping endpoints not available yet"
          : e instanceof Error
            ? e.message
            : "Failed to save mapping",
      ),
  });

  const featureMissing =
    mappings.isError && isNotFoundError(mappings.error);

  return (
    <div className="space-y-6">
      <SectionCard
        title="Analyzer code mappings"
        description="Maps inbound analyzer/ORU test codes to the local catalog and LOINC. Enrichment is fail-open at ingest and entirely dark until the LOINC-mapping gate is on and rows exist."
      >
        {mappings.isLoading && <LoadingSpinner />}
        {mappings.isError && (
          <QueryErrorNotice
            error={mappings.error}
            notAvailableMessage="Lab code-mapping endpoints not available yet (ships with the LOINC closed-loop work package)."
          />
        )}
        {mappings.data && (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Incoming code</th>
                  <th className="py-2 pr-4">LOINC</th>
                  <th className="py-2 pr-4">Display</th>
                  <th className="py-2 pr-4">State</th>
                </tr>
              </thead>
              <tbody>
                {(mappings.data.mappings ?? []).map((mapping) => (
                  <tr key={mapping.id} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 text-muted-foreground">
                      {mapping.source_key}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs text-foreground">
                      {mapping.incoming_code}
                      {mapping.incoming_code_system
                        ? ` (${mapping.incoming_code_system})`
                        : ""}
                    </td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {mapping.loinc_code ?? "—"}
                    </td>
                    <td className="py-2 pr-4 text-muted-foreground">
                      {mapping.display ?? "—"}
                    </td>
                    <td className="py-2 pr-4">
                      <OnOffPill on={mapping.active} />
                    </td>
                  </tr>
                ))}
                {(mappings.data.mappings ?? []).length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="py-4 text-center text-sm text-muted-foreground"
                    >
                      No mappings yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {!featureMissing && (
          <form
            className="mt-4 flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!form.incoming_code.trim()) {
                toast.error("Incoming code is required");
                return;
              }
              create.mutate();
            }}
          >
            {(
              [
                ["source_key", "Source key"],
                ["incoming_code", "Incoming code"],
                ["loinc_code", "LOINC code"],
                ["display", "Display"],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="text-sm text-foreground">
                <span className="mb-1 block text-xs text-muted-foreground">
                  {label}
                </span>
                <input
                  type="text"
                  value={form[field]}
                  onChange={(e) =>
                    setForm((previous) => ({
                      ...previous,
                      [field]: e.target.value,
                    }))
                  }
                  className="rounded-md border border-input bg-card px-3 py-2 text-sm"
                />
              </label>
            ))}
            <button
              type="submit"
              disabled={create.isPending}
              className="rounded-md border border-input px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50"
            >
              {create.isPending ? "Saving…" : "Add mapping"}
            </button>
          </form>
        )}
      </SectionCard>

      <SectionCard
        title="Mapping coverage"
        description="Mapped vs distinct inbound codes seen recently, plus catalog LOINC-binding coverage."
      >
        {coverage.isLoading && <LoadingSpinner />}
        {coverage.isError && (
          <QueryErrorNotice
            error={coverage.error}
            notAvailableMessage="Mapping coverage endpoint not available yet."
          />
        )}
        {coverage.data && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">
                Distinct inbound codes
              </div>
              <div className="text-lg font-semibold text-foreground">
                {formatCount(coverage.data.distinct_incoming_codes)}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">Mapped</div>
              <div className="text-lg font-semibold text-foreground">
                {formatCount(coverage.data.mapped_codes)}
                {typeof coverage.data.mapped_pct === "number"
                  ? ` (${coverage.data.mapped_pct}%)`
                  : ""}
              </div>
            </div>
            <div className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">
                Catalog LOINC-bound
              </div>
              <div className="text-lg font-semibold text-foreground">
                {typeof coverage.data.catalog_loinc_bound_pct === "number"
                  ? `${coverage.data.catalog_loinc_bound_pct}%`
                  : "—"}
              </div>
            </div>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
