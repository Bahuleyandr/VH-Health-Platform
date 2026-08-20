"use client";

// Tab 2 — binding curation: run name-match suggestions for a local catalog,
// then confirm or reject individual rows. Writes are curator-role-gated
// server-side (TERMINOLOGY_CURATOR_ROLES).

import { LoadingSpinner } from "@/components/LoadingSpinner";
import {
  saveTerminologyBinding,
  suggestTerminologyBindings,
  TERMINOLOGY_CATALOG_TYPES,
  type TerminologyBindingSuggestion,
  type TerminologyCatalogType,
} from "@/lib/api/terminologyAdmin";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "react-hot-toast";

import { QueryErrorNotice, SectionCard } from "./shared";

export default function BindingsTab() {
  const [catalogType, setCatalogType] =
    useState<TerminologyCatalogType>("investigation_test");
  const [suggestions, setSuggestions] = useState<
    TerminologyBindingSuggestion[]
  >([]);
  const [resolved, setResolved] = useState<Record<string, string>>({});

  const suggest = useMutation({
    mutationFn: () =>
      suggestTerminologyBindings({ catalog_type: catalogType, limit: 50 }),
    onSuccess: (data) => {
      setSuggestions(data.suggestions);
      setResolved({});
      if (data.count === 0) {
        toast.success("No unbound catalog rows matched a concept name.");
      }
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Suggestion run failed"),
  });

  const decide = useMutation({
    mutationFn: ({
      suggestion,
      status,
    }: {
      suggestion: TerminologyBindingSuggestion;
      status: "confirmed" | "rejected";
    }) =>
      saveTerminologyBinding({
        catalog_type: catalogType,
        catalog_id: suggestion.catalog_id,
        system: suggestion.system_key,
        code: suggestion.code,
        display: suggestion.display,
        binding_status: status,
        confidence: suggestion.confidence,
      }),
    onSuccess: (_data, { suggestion, status }) => {
      setResolved((previous) => ({
        ...previous,
        [`${suggestion.catalog_id}:${suggestion.code}`]: status,
      }));
      toast.success(`Binding ${status}`);
    },
    onError: (e) =>
      toast.error(e instanceof Error ? e.message : "Binding write failed"),
  });

  return (
    <SectionCard
      title="Binding curation"
      description="Suggest standard-code bindings for unbound local catalog rows by name match, then confirm or reject each suggestion. Confirmed bindings feed coverage and downstream code mapping."
    >
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm text-foreground">
          <span className="mb-1 block text-xs text-muted-foreground">
            Catalog
          </span>
          <select
            value={catalogType}
            onChange={(e) =>
              setCatalogType(e.target.value as TerminologyCatalogType)
            }
            className="rounded-md border border-input bg-card px-3 py-2 text-sm"
          >
            {TERMINOLOGY_CATALOG_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={suggest.isPending}
          onClick={() => suggest.mutate()}
          className="rounded-md border border-input px-3 py-2 text-sm text-foreground hover:bg-muted disabled:opacity-50"
        >
          {suggest.isPending ? "Running…" : "Run suggestions"}
        </button>
      </div>

      {suggest.isPending && <LoadingSpinner />}
      {suggest.isError && (
        <QueryErrorNotice
          error={suggest.error}
          notAvailableMessage="Binding suggestions not available."
        />
      )}

      {suggestions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 pr-4">Catalog row</th>
                <th className="py-2 pr-4">Suggested code</th>
                <th className="py-2 pr-4">Confidence</th>
                <th className="py-2 pr-4">Decision</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((suggestion) => {
                const key = `${suggestion.catalog_id}:${suggestion.code}`;
                const decision = resolved[key];
                return (
                  <tr key={key} className="border-b last:border-b-0">
                    <td className="py-2 pr-4 text-foreground">
                      {suggestion.catalog_name ?? `#${suggestion.catalog_id}`}
                    </td>
                    <td className="py-2 pr-4">
                      <span className="font-mono text-xs">
                        {suggestion.system_key} {suggestion.code}
                      </span>
                      <div className="text-xs text-muted-foreground">
                        {suggestion.display ?? ""}
                      </div>
                    </td>
                    <td className="py-2 pr-4">
                      {Math.round(suggestion.confidence * 100)}%
                    </td>
                    <td className="py-2 pr-4">
                      {decision ? (
                        <span className="text-xs font-medium text-muted-foreground">
                          {decision}
                        </span>
                      ) : (
                        <span className="flex gap-2">
                          <button
                            type="button"
                            disabled={decide.isPending}
                            onClick={() =>
                              decide.mutate({ suggestion, status: "confirmed" })
                            }
                            className="rounded-md border border-success px-2 py-1 text-xs text-success hover:bg-success/10 disabled:opacity-50"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            disabled={decide.isPending}
                            onClick={() =>
                              decide.mutate({ suggestion, status: "rejected" })
                            }
                            className="rounded-md border border-input px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
