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

// The list of server-derived identity keys callers persist consistently.
// (`name` is returned by the resolver for convenience but is NOT an identity
// field callers overwrite — it is the catalog's own display name.)
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
 * @returns {Promise<Map<number, object>>} keyed by catalog_id (number). Never throws.
 */
export async function resolveCompositionIdentitiesByCatalogIds(tenantId, catalogIds) {
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
    const rows = await prisma.$queryRawUnsafe(sql, tenantId, ...ids);
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
 * Returns a NEW array (does not mutate the input). For each med:
 *   - a med WITHOUT a catalog_id passes through unchanged (a free-text med
 *     legitimately carries no catalog identity — we do not strip or fabricate);
 *   - a med WITH a catalog_id has any client-sent identity fields stripped
 *     first (never trusted), then, if the server resolves an identity for that
 *     catalog_id, the COMPOSITION_IDENTITY_FIELDS subset is merged on;
 *   - a med WITH a catalog_id that does NOT resolve (wrong tenant / inactive)
 *     keeps its client identity stripped and absent — the client value is
 *     never trusted.
 *
 * @param {string} tenantId
 * @param {Array<object>} meds
 * @returns {Promise<Array<object>>} never throws
 */
export async function enrichMedicationsWithComposition(tenantId, meds) {
  if (!Array.isArray(meds) || meds.length === 0) return [];

  // Collect catalog ids (accept catalog_id or catalogId), coerce to positive int.
  const ids = [];
  for (const med of meds) {
    const catalogId = toPositiveInt(med?.catalog_id ?? med?.catalogId);
    if (catalogId !== null) ids.push(catalogId);
  }

  const identities = await resolveCompositionIdentitiesByCatalogIds(tenantId, ids);

  return meds.map((med) => {
    const catalogId = toPositiveInt(med?.catalog_id ?? med?.catalogId);

    // No catalog_id at all → pass through unchanged (free-text med).
    if (catalogId === null) return med;

    // Has a catalog_id → strip any client-sent identity (never trusted).
    const next = { ...med };
    for (const field of COMPOSITION_IDENTITY_FIELDS) {
      delete next[field];
    }

    // Overlay the server-derived identity when we have one.
    const identity = identities.get(catalogId);
    if (identity) {
      for (const field of COMPOSITION_IDENTITY_FIELDS) {
        next[field] = identity[field];
      }
    }
    return next;
  });
}
