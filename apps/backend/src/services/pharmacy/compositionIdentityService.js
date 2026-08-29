// src/services/pharmacy/compositionIdentityService.js
//
// Server-authoritative drug-composition identity resolver (Phase 2, inert/gated).
//
// The core security invariant of composition-based drug search: the server
// derives composition identity ONLY from the tenant-scoped `pharmacy_catalog`
// row keyed by `catalog_id`. A client-supplied `composition_id` (or any of the
// identity fields below) is NEVER trusted or persisted as fact — it is stripped
// and, when we hold a resolvable catalog_id, overwritten with the server value.
//
// Later tasks (safety checks, identity persistence, substitution audit) all
// consume this resolver so they agree on one derivation path. This module does
// NOT wire itself into any route/controller/service caller.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

// The full list of server-derived identity keys the resolver's Map holds for
// each catalog row (`name` is also returned for convenience but is not listed
// here — it is the catalog's own display name). This documents the complete
// derived set; callers that read the Map directly (/alternatives T4, the
// substitution audit T7) rely on all of these.
//
// NOTE: the enrich OVERLAY does NOT apply this full set — it applies the
// narrower COMPOSITION_OVERLAY_FIELDS (the 9 canonical fields), so the four
// clinician clinical free-text fields present here (`strength`, `form`, `route`,
// `generic_name`) are NEVER overwritten on an enriched med. See
// COMPOSITION_OVERLAY_FIELDS and enrichMedicationsWithComposition below.
export const COMPOSITION_IDENTITY_FIELDS = [
  'composition_id',
  'composition_key',
  'active_ingredients',
  'composition_label',
  'strength',
  'strength_key',
  'strength_components',
  'form',
  'form_key',
  'release_key',
  'route',
  'composition_confidence',
  'generic_name',
];

// Canonical/derived-only identity fields that a clinician NEVER types — they can
// only be server-derived from a tenant-scoped catalog row. These are stripped
// from EVERY med unconditionally (before any overlay) so a forged value can
// never ride through, regardless of catalog_id validity.
//
// This is deliberately a STRICT SUBSET of COMPOSITION_IDENTITY_FIELDS: it
// EXCLUDES the fields a free-text prescription med legitimately carries as
// clinician input — `strength`, `form`, `route`, `generic_name`. Those pass
// through untouched for an unresolved med (and are overwritten by catalog
// values via the full overlay for a resolved one).
export const CLIENT_UNTRUSTED_COMPOSITION_FIELDS = [
  'composition_id',
  'composition_key',
  'composition_label',
  'active_ingredients',
  'strength_key',
  'form_key',
  'release_key',
  'composition_confidence',
  'strength_components',
];

// The fields the enrich OVERLAY applies from the resolved catalog row. This is
// intentionally the SAME set as CLIENT_UNTRUSTED_COMPOSITION_FIELDS — a clean
// symmetry: strip the 9 canonical/server-derived fields a client can forge, then
// overlay the 9 canonical/server-derived fields the catalog actually holds.
//
// It deliberately EXCLUDES the four clinician-entered clinical free-text fields
// — `strength`, `form`, `route`, `generic_name`. Those are NOT overlaid: whatever
// the clinician/client sent is left verbatim. This keeps the always-on persist
// path (T6) inert for clinician-visible clinical fields — a doctor who sets
// route:'IV' (or the catalog's route/strength column being NULL) never has that
// value overwritten or blanked. The resolver's Map still returns all catalog
// fields for callers that read them directly (/alternatives T4, audit T7).
export const COMPOSITION_OVERLAY_FIELDS = [
  'composition_id',
  'composition_key',
  'composition_label',
  'active_ingredients',
  'strength_key',
  'form_key',
  'release_key',
  'composition_confidence',
  'strength_components',
];

// Coerce an arbitrary value to a positive integer id, or null if not one.
function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * Resolve server-authoritative composition identities for a set of catalog ids,
 * scoped to a single tenant and to active catalog rows only.
 *
 * @param {string} tenantId  tenant uuid (RLS scope)
 * @param {Array<number|string>} catalogIds  pharmacy_catalog ids
 * @param {object} [options]
 * @param {object} [options.db]  Prisma client or transaction client. The
 *   composition API is OPTIONS-OBJECT shaped ({ db }) — pass a tx client here to
 *   read inside an open transaction; never pass the client positionally.
 * @returns {Promise<Map<number, object>>} keyed by catalog_id (number). Never throws.
 */
export async function resolveCompositionIdentitiesByCatalogIds(
  tenantId,
  catalogIds,
  { db = prisma } = {},
) {
  const result = new Map();

  if (!tenantId) return result;
  if (!Array.isArray(catalogIds) || catalogIds.length === 0) return result;

  // Dedupe + coerce to positive integers; drop non-numeric / NaN / <= 0.
  const ids = [...new Set(
    catalogIds.map(toPositiveInt).filter((n) => n !== null),
  )];
  if (ids.length === 0) return result;

  // Build the IN(...) placeholder list dynamically and SPREAD the ids as
  // individual params ($2, $3, ...). Never pass a JS array as one param.
  const inList = ids.map((_, i) => `$${i + 2}`).join(', ');
  const sql = `
    SELECT pc.id AS catalog_id, pc.composition_id, dc.composition_key, dc.active_ingredients,
           dc.display_label AS composition_label, pc.strength, pc.strength_key,
           pc.strength_components, pc.form, pc.form_key, pc.release_key, pc.route,
           pc.composition_confidence, pc.generic_name, pc.name
      FROM pharmacy_catalog pc
      LEFT JOIN drug_compositions dc ON dc.id = pc.composition_id
     WHERE pc.tenant_id = $1::uuid AND pc.is_active AND pc.id IN (${inList})`;

  try {
    const rows = await db.$queryRawUnsafe(sql, tenantId, ...ids);
    for (const row of rows) {
      const catalogId = Number(row.catalog_id);
      result.set(catalogId, {
        catalog_id: catalogId,
        composition_id: row.composition_id === null || row.composition_id === undefined
          ? null
          : Number(row.composition_id),
        composition_key: row.composition_key ?? null,
        active_ingredients: row.active_ingredients ?? null,
        composition_label: row.composition_label ?? null,
        strength: row.strength ?? null,
        strength_key: row.strength_key ?? null,
        strength_components: row.strength_components ?? null,
        form: row.form ?? null,
        form_key: row.form_key ?? null,
        release_key: row.release_key ?? null,
        route: row.route ?? null,
        composition_confidence: row.composition_confidence ?? null,
        generic_name: row.generic_name ?? null,
        name: row.name ?? null,
      });
    }
  } catch (err) {
    // Missing column/table during a staggered deploy, DB down, breaker open —
    // never throw. Composition identity is an enrichment, not a hard dependency.
    logger.warn('compositionIdentityService: resolve failed, returning empty identity map', {
      error: err?.message,
      idCount: ids.length,
    });
    return new Map();
  }

  return result;
}

/**
 * Enrich a list of medications with server-derived composition identity.
 *
 * Returns a NEW array (does not mutate the input). For EVERY med, the
 * canonical/derived-only fields (CLIENT_UNTRUSTED_COMPOSITION_FIELDS) are
 * stripped first — a client-sent `composition_id` (or any canonical field) is
 * NEVER trusted or persisted as fact, regardless of catalog_id validity. Then:
 *   - a med with a RESOLVABLE catalog_id has the server-derived CANONICAL
 *     identity (COMPOSITION_OVERLAY_FIELDS — the same 9 fields, EXCLUDING the
 *     four clinician clinical free-text fields) overlaid on the stripped copy;
 *   - a med WITHOUT a resolvable catalog_id (missing / 0 / negative /
 *     non-numeric / wrong tenant / inactive) returns the stripped copy with NO
 *     canonical composition fields and nothing fabricated.
 *
 * Clinician clinical free-text (`strength` / `form` / `route` / `generic_name` /
 * dose / name / …) is preserved VERBATIM in every case — it is neither stripped
 * (not in the untrusted set) nor overwritten (not in the overlay set). This is
 * the inertness guarantee for the always-on persist path.
 *
 * @param {string} tenantId
 * @param {Array<object>} meds
 * @param {object} [options]
 * @param {object} [options.db]  Prisma client or transaction client ({ db }
 *   options-object shape — see resolveCompositionIdentitiesByCatalogIds).
 * @returns {Promise<Array<object>>} never throws
 */
export async function enrichMedicationsWithComposition(tenantId, meds, { db = prisma } = {}) {
  if (!Array.isArray(meds) || meds.length === 0) return [];

  // Collect catalog ids (accept catalog_id or catalogId), coerce to positive int.
  const ids = [];
  for (const med of meds) {
    const catalogId = toPositiveInt(med?.catalog_id ?? med?.catalogId);
    if (catalogId !== null) ids.push(catalogId);
  }

  const identities = await resolveCompositionIdentitiesByCatalogIds(tenantId, ids, { db });

  return meds.map((med) => {
    // Strip forged canonical/derived-only fields from EVERY med (never trusted),
    // on a shallow copy so the input is not mutated.
    const next = { ...med };
    for (const field of CLIENT_UNTRUSTED_COMPOSITION_FIELDS) {
      delete next[field];
    }

    // Overlay ONLY the canonical/server-derived fields for a resolvable
    // catalog_id. The four clinician clinical free-text fields (strength / form /
    // route / generic_name) are intentionally NOT in COMPOSITION_OVERLAY_FIELDS,
    // so the clinician's value survives verbatim (inertness — see the constant).
    const catalogId = toPositiveInt(med?.catalog_id ?? med?.catalogId);
    if (catalogId !== null) {
      const identity = identities.get(catalogId);
      if (identity) {
        for (const field of COMPOSITION_OVERLAY_FIELDS) {
          next[field] = identity[field];
        }
      }
    }
    return next;
  });
}
