// Generic clinical-AI API helpers. Lets Phase-2 panels plug in a backend path
// and skip the per-module wrapper boilerplate that fills most of emr.ts.
//
// Copies the exact fetch pattern used by the bespoke helpers in emr.ts (e.g.
// `listAntimicrobialStewardshipReviews`, `decideAntimicrobialStewardshipReview`):
// GETs go through `getJSON`, PATCHes through `fetchAdminAPI`, POSTs through
// `postJSON` — all of which share the same auth + envelope-unwrap behaviour.
//
// For the typed-helper pattern, see:
//   apps/admin/src/lib/api/clinicalAiModules.ts — `listAntimicrobialStewardshipReviews`
//   apps/admin/src/lib/api/clinicalAiModules.ts — `decideAntimicrobialStewardshipReview`
//   apps/admin/src/lib/api/core.ts — `getJSON`, `postJSON`, `fetchAdminAPI`

import { fetchAdminAPI, getJSON, postJSON } from "./core";

export type ClinicalAIListParams = Record<string, unknown> & { limit?: number };

type GenericListResult = Record<string, unknown> & { count: number };
type GenericResult = Record<string, unknown>;

/**
 * Coerce arbitrary param values into the `QueryParams` shape that `getJSON`
 * accepts (string | number | boolean | null | undefined). Unknown objects
 * are JSON-stringified so callers can pass structured filters without
 * reaching for a custom list helper.
 */
function toQueryParams(params: ClinicalAIListParams): Record<string, string | number | boolean | null | undefined> {
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.stringify(value);
    } catch {
      // Best-effort: drop unserializable values rather than crashing the call.
    }
  }
  return out;
}

/**
 * Generic list helper. Expects the backend to return an envelope that
 * includes `count` and at least one plural rows key (e.g.
 * `{ advisories, count }` or `{ anomalies, count }`). The caller's
 * `ClinicalAIReviewQueue` config names the rows key via `rowsKey` so the
 * queue component can pluck the array regardless of which module it wraps.
 *
 * @example
 *   listClinicalAi('/admin/clinical-ai/security-anomalies', { severity: 'high', limit: 50 })
 *     => Promise<{ anomalies: SecurityAnomaly[]; count: number }>
 */
export async function listClinicalAi(
  path: string,
  params: ClinicalAIListParams = {}
): Promise<GenericListResult> {
  return getJSON<GenericListResult>(path, toQueryParams(params));
}

/**
 * Generic decide helper — PATCHes a single row with the reviewer decision
 * and an optional note. Matches the body shape used by every existing
 * clinical-AI decide helper: `{ decision, note }`.
 *
 * @example
 *   decideClinicalAi('/admin/clinical-ai/security-anomalies', 42, 'acknowledged', 'investigating')
 */
export async function decideClinicalAi(
  path: string,
  id: number | string,
  decision: string,
  note?: string | null
): Promise<GenericResult> {
  return fetchAdminAPI<GenericResult>(`${path}/${id}`, {
    method: "PATCH",
    body: { decision, note: note ?? null },
  });
}

/**
 * Generic evaluate helper — POSTs arbitrary body and returns the raw
 * response envelope. Used by modules that have a "generate" / "run review"
 * action separate from the list + decide flow (e.g. the PGx advisory
 * evaluator).
 *
 * @example
 *   evaluateClinicalAi(
 *     '/admin/clinical-ai/pgx/advisories/evaluate',
 *     { patient_uid: 'abc', medication_name: 'clopidogrel' },
 *   )
 */
export async function evaluateClinicalAi(
  path: string,
  body: Record<string, unknown>
): Promise<GenericResult> {
  return postJSON<GenericResult>(path, body);
}

/**
 * Generic PATCH helper for endpoints that accept an arbitrary body shape
 * (i.e. not the standard `{ decision, note }` contract handled by
 * `decideClinicalAi`). Used for stage / status change endpoints like:
 *   - `PATCH /admin/clinical-ai/model-registry/:id/stage`
 *     body: `{ stage, approval_status?, approval_note? }`
 *   - `PATCH /admin/clinical-ai/agent-registry/:id/stage`
 *     body: `{ stage, approval_status?, approval_note? }`
 *   - `PATCH /admin/clinical-ai/federation/sites/:id/status`
 *     body: `{ status, approval_status?, approval_note? }`
 *
 * @example
 *   patchClinicalAi(
 *     '/admin/clinical-ai/agent-registry/42/stage',
 *     { stage: 'production', approval_status: 'approved', approval_note: 'Ready' },
 *   )
 */
export async function patchClinicalAi(
  path: string,
  body: Record<string, unknown>
): Promise<GenericResult> {
  return fetchAdminAPI<GenericResult>(path, {
    method: "PATCH",
    body,
  });
}
