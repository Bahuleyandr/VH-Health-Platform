// src/services/clinical/drugKbLinkService.js
//
// Terminology slate C1 / WP4 — deterministic pharmacy-formulary → drug-KB
// key resolution (migration 722).
//
// The DDI engine (drugKnowledgeBaseService) historically matches free-text
// medication names by case-insensitive substring against monograph keys +
// alias lists. This adapter resolves a medication that carries a
// pharmacy_catalog id DETERMINISTICALLY, in tier order:
//
//   1. explicit link row      drug_kb_catalog_links (manual | vendor_import)
//   2. ATC binding join       terminology_catalog_bindings
//                             (catalog_type='pharmacy_item', system_key='ATC',
//                             confirmed) × drug_kb_monographs.atc_code
//   3. composition ingredients pharmacy_catalog.composition_id →
//                             drug_compositions.active_ingredients matched
//                             exactly (normalized) against monograph
//                             keys/aliases
//   4. null                   caller falls back to the existing substring path
//
// Design rules (mirroring the engine's own):
//   * DOUBLE-GATED and dark by default: env DRUG_KB_DETERMINISTIC_MATCHING
//     AND tenant settings.drugKb.deterministicMatching must BOTH be true or
//     resolveDrugKeys reports { enabled: false } without touching the DB.
//     With the gates off every consumer is byte-identical to today.
//   * NEVER throws out of resolveDrugKeys/coverageReport — a missing table
//     (un-migrated env), DB error, or breaker-open yields the disabled/empty
//     result. Deterministic resolution is an enhancement over the substring
//     floor, never a new failure mode. The CPOE prescription path's
//     fail-CLOSED posture lives in validatePrescriptionSafety and is
//     untouched by this module.
//   * This module must NOT import drugKnowledgeBaseService (the engine
//     imports us — keep the dependency one-way).

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { getDrugKbSettings } from '../tenant/tenantSettingsService.js';

const MONOGRAPH_CACHE_TTL_MS = 5 * 60 * 1000;
let monographCache = { loadedAt: 0, rows: null };

/** Test hook — drop the monograph identity cache. */
export function __resetDrugKbLinkCache() {
  monographCache = { loadedAt: 0, rows: null };
}

/** Env kill switch for the deterministic-matching feature family. */
export function isDrugKbDeterministicEnvEnabled() {
  return process.env.DRUG_KB_DETERMINISTIC_MATCHING === 'true';
}

function isSchemaMissing(err) {
  const code = err?.meta?.code
    || err?.meta?.driverAdapterError?.cause?.originalCode
    || err?.code;
  return code === '42P01'
    || code === '42703'
    || /relation .* does not exist|column .* does not exist/i.test(String(err?.message || ''));
}

function normalizeIngredient(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function toPositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function catalogIdOf(med) {
  return toPositiveInt(med?.catalog_id ?? med?.catalogId);
}

/** Active-source monograph identities: drug_key, atc_code, aliases. TTL-cached. */
async function loadMonographIdentities() {
  if (monographCache.rows && Date.now() - monographCache.loadedAt < MONOGRAPH_CACHE_TTL_MS) {
    return monographCache.rows;
  }
  const rows = await prisma.$queryRawUnsafe(
    `SELECT m.drug_key, m.atc_code, m.aliases
       FROM drug_kb_monographs m
       JOIN drug_kb_sources s ON s.source_key = m.source_key AND s.is_active`,
  );
  const identities = (rows || []).map((row) => ({
    drug_key: String(row.drug_key || '').toLowerCase(),
    atc_code: row.atc_code ? String(row.atc_code).toUpperCase() : null,
    aliases: (row.aliases || []).map((a) => normalizeIngredient(a)).filter(Boolean),
  }));
  monographCache = { loadedAt: Date.now(), rows: identities };
  return identities;
}

/** Build ingredient-name → Set(drug_key) lookup from monograph identities. */
function ingredientIndex(identities) {
  const index = new Map();
  const add = (label, key) => {
    const norm = normalizeIngredient(label);
    if (!norm) return;
    if (!index.has(norm)) index.set(norm, new Set());
    index.get(norm).add(key);
  };
  for (const mono of identities) {
    add(mono.drug_key, mono.drug_key);
    for (const alias of mono.aliases) add(alias, mono.drug_key);
  }
  return index;
}

/**
 * Resolve deterministic KB drug keys for a medication list.
 *
 * @param {object} params
 * @param {string} params.tenantId  tenant uuid (required for any resolution)
 * @param {Array<object>} params.medications  meds; only entries carrying a
 *        catalog_id/catalogId can resolve deterministically
 * @returns {Promise<{enabled: boolean, resolutions: Array<{catalog_id: number,
 *        drug_keys: string[], tier: 'explicit_link'|'atc'|'composition'}|null>|null}>}
 *        `resolutions` is parallel to `medications`; null per med means "no
 *        deterministic resolution — use the substring fallback". Never throws.
 */
export async function resolveDrugKeys({ tenantId, medications = [] } = {}) {
  const disabled = { enabled: false, resolutions: null };
  try {
    if (!tenantId || !Array.isArray(medications) || medications.length === 0) return disabled;
    if (!isDrugKbDeterministicEnvEnabled()) return disabled;
    const settings = await getDrugKbSettings(tenantId);
    if (!settings.deterministicMatching) return disabled;

    const catalogIds = [...new Set(medications.map(catalogIdOf).filter((n) => n !== null))];
    if (catalogIds.length === 0) {
      return { enabled: true, resolutions: medications.map(() => null) };
    }

    const inList = catalogIds.map((_, i) => `$${i + 2}`).join(', ');

    // Tier 1 — explicit link rows (manual | vendor_import), live + not vetoed.
    const linkRows = await prisma.$queryRawUnsafe(
      `SELECT pharmacy_catalog_id, drug_key, link_source, confidence
         FROM drug_kb_catalog_links
        WHERE tenant_id = $1::uuid AND is_active
          AND review_status NOT IN ('rejected', 'retired')
          AND pharmacy_catalog_id IN (${inList})`,
      tenantId, ...catalogIds,
    );

    const identities = await loadMonographIdentities();
    const knownKeys = new Set(identities.map((m) => m.drug_key));
    const byAtc = new Map();
    for (const mono of identities) {
      if (!mono.atc_code) continue;
      if (!byAtc.has(mono.atc_code)) byAtc.set(mono.atc_code, new Set());
      byAtc.get(mono.atc_code).add(mono.drug_key);
    }

    // Tier 2 — confirmed ATC bindings on the pharmacy item (bindings are
    // global rows keyed by catalog_id; catalog ids are tenant-scoped rows we
    // already filtered above).
    const atcRows = await prisma.$queryRawUnsafe(
      `SELECT catalog_id, UPPER(code) AS atc_code
         FROM terminology_catalog_bindings
        WHERE catalog_type = 'pharmacy_item' AND system_key = 'ATC'
          AND binding_status = 'confirmed'
          AND catalog_id IN (${catalogIds.map((_, i) => `$${i + 1}`).join(', ')})`,
      ...catalogIds,
    ).catch((err) => {
      if (isSchemaMissing(err)) return [];
      throw err;
    });

    // Tier 3 — composition ingredients of the catalog rows.
    const compositionRows = await prisma.$queryRawUnsafe(
      `SELECT pc.id AS catalog_id, dc.active_ingredients
         FROM pharmacy_catalog pc
         JOIN drug_compositions dc ON dc.id = pc.composition_id
        WHERE pc.tenant_id = $1::uuid AND pc.is_active AND pc.id IN (${inList})`,
      tenantId, ...catalogIds,
    ).catch((err) => {
      if (isSchemaMissing(err)) return [];
      throw err;
    });

    const explicitByCatalog = new Map();
    for (const row of linkRows || []) {
      const id = Number(row.pharmacy_catalog_id);
      const key = String(row.drug_key || '').toLowerCase().trim();
      if (!key) continue;
      if (!explicitByCatalog.has(id)) explicitByCatalog.set(id, new Set());
      explicitByCatalog.get(id).add(key);
    }

    const atcByCatalog = new Map();
    for (const row of atcRows || []) {
      const id = Number(row.catalog_id);
      const keys = byAtc.get(String(row.atc_code || '').toUpperCase());
      if (!keys || keys.size === 0) continue;
      if (!atcByCatalog.has(id)) atcByCatalog.set(id, new Set());
      for (const key of keys) atcByCatalog.get(id).add(key);
    }

    const ingredients = ingredientIndex(identities);
    const compositionByCatalog = new Map();
    for (const row of compositionRows || []) {
      const id = Number(row.catalog_id);
      const hits = new Set();
      for (const ingredient of row.active_ingredients || []) {
        const keys = ingredients.get(normalizeIngredient(ingredient));
        if (keys) for (const key of keys) hits.add(key);
      }
      if (hits.size > 0) compositionByCatalog.set(id, hits);
    }

    const resolveOne = (catalogId) => {
      if (catalogId === null) return null;
      const explicit = explicitByCatalog.get(catalogId);
      // An explicit link is authoritative even when its key is not (yet) in
      // an active KB source — the engine simply finds no facts for it.
      if (explicit && explicit.size > 0) {
        return { catalog_id: catalogId, drug_keys: [...explicit], tier: 'explicit_link' };
      }
      const atc = atcByCatalog.get(catalogId);
      if (atc && atc.size > 0) {
        const atcKeys = [...atc].filter((k) => knownKeys.has(k));
        if (atcKeys.length > 0) return { catalog_id: catalogId, drug_keys: atcKeys, tier: 'atc' };
      }
      const composition = compositionByCatalog.get(catalogId);
      if (composition && composition.size > 0) {
        return { catalog_id: catalogId, drug_keys: [...composition], tier: 'composition' };
      }
      return null;
    };

    return {
      enabled: true,
      resolutions: medications.map((med) => {
        const resolution = resolveOne(catalogIdOf(med));
        if (!resolution || resolution.drug_keys.length === 0) return null;
        return resolution;
      }),
    };
  } catch (err) {
    if (isSchemaMissing(err)) {
      logger.warn('drug_kb_catalog_links unavailable — deterministic matching skipped (migrate 722 to enable)', {
        error: err?.message,
      });
    } else {
      logger.warn('drugKbLinkService.resolveDrugKeys failed — falling back to substring matching', {
        error: err?.message,
      });
    }
    return disabled;
  }
}

/**
 * Formulary coverage report for GET /api/v1/drug-kb/coverage: how much of the
 * tenant's active pharmacy_catalog resolves to a KB drug key, per tier. Each
 * catalog item is counted once at its highest-precedence tier. Read-only and
 * NOT gated (the console needs visibility before flipping the gates); never
 * throws — a missing substrate yields zeroed stats with kb_available:false.
 */
export async function coverageReport({ tenantId } = {}) {
  const empty = {
    kb_available: false,
    total_active_catalog_items: 0,
    resolved: {
      explicit_link: 0, atc_binding: 0, composition: 0, text_fallback: 0,
    },
    unmatched: 0,
    deterministic_pct: 0,
    any_pct: 0,
    deterministic_matching: {
      env_enabled: isDrugKbDeterministicEnvEnabled(),
      tenant_enabled: false,
      effective: false,
    },
  };
  try {
    if (!tenantId) return empty;
    const settings = await getDrugKbSettings(tenantId).catch(() => ({ deterministicMatching: false }));
    empty.deterministic_matching.tenant_enabled = settings.deterministicMatching === true;
    empty.deterministic_matching.effective = empty.deterministic_matching.env_enabled
      && empty.deterministic_matching.tenant_enabled;

    // Bounded catalog scan: id + name + generic_name of active items.
    const catalogRows = await prisma.$queryRawUnsafe(
      `SELECT id, name, generic_name, composition_id
         FROM pharmacy_catalog
        WHERE tenant_id = $1::uuid AND is_active
        ORDER BY id
        LIMIT 20000`,
      tenantId,
    );
    const total = (catalogRows || []).length;
    if (total === 0) return { ...empty, kb_available: true };

    const [linkRows, atcRows, compositionRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT DISTINCT pharmacy_catalog_id AS catalog_id
           FROM drug_kb_catalog_links
          WHERE tenant_id = $1::uuid AND is_active
            AND review_status NOT IN ('rejected', 'retired')`,
        tenantId,
      ).catch((err) => { if (isSchemaMissing(err)) return []; throw err; }),
      prisma.$queryRawUnsafe(
        `SELECT DISTINCT b.catalog_id
           FROM terminology_catalog_bindings b
           JOIN drug_kb_monographs m
             ON m.atc_code IS NOT NULL AND UPPER(m.atc_code) = UPPER(b.code)
           JOIN drug_kb_sources s ON s.source_key = m.source_key AND s.is_active
          WHERE b.catalog_type = 'pharmacy_item' AND b.system_key = 'ATC'
            AND b.binding_status = 'confirmed'`,
      ).catch((err) => { if (isSchemaMissing(err)) return []; throw err; }),
      prisma.$queryRawUnsafe(
        `SELECT pc.id AS catalog_id, dc.active_ingredients
           FROM pharmacy_catalog pc
           JOIN drug_compositions dc ON dc.id = pc.composition_id
          WHERE pc.tenant_id = $1::uuid AND pc.is_active`,
        tenantId,
      ).catch((err) => { if (isSchemaMissing(err)) return []; throw err; }),
    ]);

    const identities = await loadMonographIdentities();
    const ingredients = ingredientIndex(identities);

    const linked = new Set((linkRows || []).map((r) => Number(r.catalog_id)));
    const atcResolved = new Set((atcRows || []).map((r) => Number(r.catalog_id)));
    const compositionResolved = new Set();
    for (const row of compositionRows || []) {
      for (const ingredient of row.active_ingredients || []) {
        if (ingredients.has(normalizeIngredient(ingredient))) {
          compositionResolved.add(Number(row.catalog_id));
          break;
        }
      }
    }

    // Text-fallback tier: today's substring behavior over name + generic_name.
    const aliasTokens = [];
    for (const mono of identities) {
      aliasTokens.push([mono.drug_key, mono.drug_key]);
      for (const alias of mono.aliases) aliasTokens.push([alias, mono.drug_key]);
    }

    let explicitCount = 0;
    let atcCount = 0;
    let compositionCount = 0;
    let textCount = 0;
    let unmatched = 0;
    for (const row of catalogRows) {
      const id = Number(row.id);
      if (linked.has(id)) { explicitCount += 1; continue; }
      if (atcResolved.has(id)) { atcCount += 1; continue; }
      if (compositionResolved.has(id)) { compositionCount += 1; continue; }
      const text = normalizeIngredient(`${row.name || ''} ${row.generic_name || ''}`);
      const textHit = text && aliasTokens.some(([token]) => token && text.includes(token));
      if (textHit) { textCount += 1; continue; }
      unmatched += 1;
    }

    const deterministic = explicitCount + atcCount + compositionCount;
    const pct = (n) => Math.round((n / total) * 1000) / 10;
    return {
      kb_available: true,
      total_active_catalog_items: total,
      resolved: {
        explicit_link: explicitCount,
        atc_binding: atcCount,
        composition: compositionCount,
        text_fallback: textCount,
      },
      unmatched,
      deterministic_pct: pct(deterministic),
      any_pct: pct(deterministic + textCount),
      deterministic_matching: empty.deterministic_matching,
    };
  } catch (err) {
    logger.warn('drugKbLinkService.coverageReport failed — returning empty report', {
      error: err?.message,
    });
    return empty;
  }
}

export default {
  resolveDrugKeys,
  coverageReport,
  isDrugKbDeterministicEnvEnabled,
  __resetDrugKbLinkCache,
};
