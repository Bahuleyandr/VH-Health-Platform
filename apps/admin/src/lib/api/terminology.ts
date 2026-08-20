// src/lib/api/terminology.ts
//
// Terminology service client (WP2). Consumed by the shared CodeSearchField
// typeahead; WP5's terminology console may import these helpers too. All
// calls go through the /api/proxy allowlist — the `api/v1/terminology`
// proxy prefix registration is owned by the terminology console work
// package; until it lands the search call simply fails and callers
// degrade to free text.

import { fetchAdminAPI } from "./core";

export interface TerminologyConcept {
  system_key: string;
  code: string;
  display: string | null;
  category?: string | null;
  semantic_tag?: string | null;
  status?: string | null;
}

export interface TerminologySearchResult {
  concepts: TerminologyConcept[];
  count: number;
}

function unwrap<T>(r: unknown): T {
  return ((r as { data?: T }).data ?? r) as T;
}

/**
 * Search the terminology catalogue. Omitting `system` defers to the
 * tenant's settings-driven multi-system search (terminology core contract);
 * passing one (e.g. "ICD10") searches that system only.
 */
export async function searchTerminology({
  q,
  system,
  limit = 12,
}: {
  q: string;
  system?: string;
  limit?: number;
}): Promise<TerminologyConcept[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  if (system) params.set("system", system);
  const r = await fetchAdminAPI<unknown>(
    `/terminology/search?${params.toString()}`,
  );
  const data = unwrap<TerminologySearchResult | TerminologyConcept[]>(r);
  const list = Array.isArray(data)
    ? data
    : ((data as TerminologySearchResult).concepts ?? []);
  return list.filter(
    (c): c is TerminologyConcept =>
      !!c && typeof c === "object" && !!(c as TerminologyConcept).code,
  );
}
