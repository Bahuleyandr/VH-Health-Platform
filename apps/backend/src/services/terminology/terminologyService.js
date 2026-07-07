// src/services/terminology/terminologyService.js
//
// Roadmap B8 — central terminology service (docs/EPIC_LEVEL_ROADMAP.md).
//
// One module to answer, for every standard code system the platform touches
// (ICD-10, ICD-11, SNOMED CT, LOINC, ATC):
//   * "is this a valid code?"            → validateCode()
//   * "what codes match this text?"      → searchConcepts()
//   * "how does code X map to system Y?" → mapCode()
//   * "which standard code does local catalog row N carry?"
//                                        → bind/list/suggest catalog bindings
//
// Content is imported (scripts/terminology-import.mjs), not hand-seeded —
// SNOMED CT via the free Indian national license (NRC RF2 snapshot), LOINC
// via the free Regenstrief release, ATC via the WHOCC index. Migration 275
// federates the pre-existing icd10_codes catalog so ICD-10 works on day one.
//
// LOINC special case: until the full catalogue is imported the service falls
// back to the structural validator in services/hl7/loincValidator.js, so
// existing HL7 ingestion behaviour is preserved (mode: 'structural').

import prisma, { prismaReadOnly } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import logger from '../../logging/logger.js';
import { isValidStructure as isValidLoincStructure } from '../hl7/loincValidator.js';
import whoIcdClient from './whoIcdClient.js';
import { isTerminologySystemEnabledForTenant } from './terminologySettingsService.js';

// ── System keys ────────────────────────────────────────────────────────────

export const SYSTEM_KEYS = Object.freeze({
  ICD10: 'ICD10',
  ICD11: 'ICD11',
  SNOMED_CT: 'SNOMED_CT',
  LOINC: 'LOINC',
  ATC: 'ATC',
});

export const ICD11_LOCAL_FIRST_CONCEPT_THRESHOLD = 1000;

const SYSTEM_ALIASES = Object.freeze({
  icd10: 'ICD10',
  'icd-10': 'ICD10',
  icd_10: 'ICD10',
  icd11: 'ICD11',
  'icd-11': 'ICD11',
  icd_11: 'ICD11',
  snomed: 'SNOMED_CT',
  snomedct: 'SNOMED_CT',
  'snomed-ct': 'SNOMED_CT',
  snomed_ct: 'SNOMED_CT',
  sct: 'SNOMED_CT',
  loinc: 'LOINC',
  atc: 'ATC',
});

/**
 * Canonicalize a code-system identifier ('icd-10', 'snomed', 'LOINC', a FHIR
 * uri, ...) to one of SYSTEM_KEYS. Returns null when unrecognized — callers
 * decide whether that is a 400 or a soft skip.
 */
export function normalizeSystemKey(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (Object.values(SYSTEM_KEYS).includes(text)) return text;
  const lowered = text.toLowerCase();
  if (SYSTEM_ALIASES[lowered]) return SYSTEM_ALIASES[lowered];
  // FHIR canonical URIs
  if (lowered.includes('snomed.info')) return 'SNOMED_CT';
  if (lowered.includes('loinc.org')) return 'LOINC';
  if (lowered.includes('icd-10')) return 'ICD10';
  if (lowered.includes('icd/release/11')) return 'ICD11';
  if (lowered.includes('whocc.no/atc')) return 'ATC';
  return null;
}

// ── Catalog binding targets ────────────────────────────────────────────────
//
// catalog_type → { table, nameColumns } for the local catalogs B8 maps to
// standard codes. Table/column names are fixed identifiers (never user
// input) — interpolation below is safe and lint:raw-params clean because
// every VALUE travels as a bound parameter.

export const CATALOG_TARGETS = Object.freeze({
  investigation_test: {
    table: 'investigation_test_catalog',
    nameColumns: ['name'],
    defaultSystem: 'LOINC',
  },
  pharmacy_item: {
    table: 'pharmacy_catalog',
    nameColumns: ['name', 'generic_name'],
    defaultSystem: 'ATC',
  },
  medication: {
    table: 'medications',
    nameColumns: ['name', 'generic_name'],
    defaultSystem: 'ATC',
  },
});

function requireCatalogTarget(catalogType) {
  const target = CATALOG_TARGETS[catalogType];
  if (!target) {
    throw AppError.badRequest(
      `Unknown catalog_type '${catalogType}' — expected one of ${Object.keys(CATALOG_TARGETS).join(', ')}`,
      'TERMINOLOGY_UNKNOWN_CATALOG_TYPE',
    );
  }
  return target;
}

function requireSystemKey(value) {
  const system = normalizeSystemKey(value);
  if (!system) {
    throw AppError.badRequest(
      `Unknown code system '${value}' — expected one of ${Object.values(SYSTEM_KEYS).join(', ')} (aliases accepted)`,
      'TERMINOLOGY_UNKNOWN_SYSTEM',
    );
  }
  return system;
}

function clampLimit(value, fallback = 20, max = 100) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function serializeProperties(properties = {}) {
  return JSON.stringify(properties && typeof properties === 'object' ? properties : {});
}

async function cacheIcd11Concepts(concepts = []) {
  const cached = [];
  for (const concept of concepts) {
    if (!concept?.code || !concept?.display) continue;
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO terminology_concepts
         (system_key, code, display, category, semantic_tag, status, properties)
       VALUES ('ICD11', $1, $2, $3, $4, 'active', $5::jsonb)
       ON CONFLICT (system_key, code) DO UPDATE
         SET display = EXCLUDED.display,
             category = COALESCE(EXCLUDED.category, terminology_concepts.category),
             semantic_tag = COALESCE(EXCLUDED.semantic_tag, terminology_concepts.semantic_tag),
             status = 'active',
             properties = terminology_concepts.properties || EXCLUDED.properties,
             updated_at = NOW()
       RETURNING system_key, code, display, category, semantic_tag, status, properties`,
      concept.code,
      concept.display,
      concept.category || null,
      concept.semantic_tag || null,
      serializeProperties({
        ...(concept.properties || {}),
        who_icd: {
          release_id: concept.release_id || null,
          language: concept.language || null,
          linearization_uri: concept.linearization_uri || null,
          foundation_uri: concept.foundation_uri || null,
          source: concept.source || 'who_icd_api',
        },
      }),
    );
    cached.push(rows[0]);
  }
  if (cached.length > 0) {
    await prisma.$executeRawUnsafe(
      `UPDATE terminology_code_systems
          SET concept_count = (SELECT COUNT(*) FROM terminology_concepts WHERE system_key = 'ICD11'),
              version = COALESCE($1, version),
              imported_at = COALESCE(imported_at, NOW()),
              updated_at = NOW()
        WHERE system_key = 'ICD11'`,
      concepts[0]?.release_id || null,
    );
  }
  return cached;
}

async function localSearchConcepts({ systemKey, query, limit }) {
  return prismaReadOnly.$queryRawUnsafe(
    `SELECT system_key, code, display, category, semantic_tag, status,
            CASE
              WHEN lower(code) = lower($2) THEN 0
              WHEN lower(display) LIKE lower($2) || '%' THEN 1
              ELSE 2
            END AS match_rank
       FROM terminology_concepts
      WHERE system_key = $1
        AND status = 'active'
        AND (lower(code) = lower($2) OR lower(display) LIKE '%' || lower($2) || '%')
      ORDER BY match_rank, length(display), display
      LIMIT $3::int`,
    systemKey,
    query,
    limit,
  );
}

async function conceptCountForSystem(systemKey) {
  const rows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT concept_count FROM terminology_code_systems WHERE system_key = $1`,
    systemKey,
  );
  return Number(rows[0]?.concept_count) || 0;
}

async function shouldSearchIcd11LocalFirst() {
  const conceptCount = await conceptCountForSystem('ICD11');
  return conceptCount > ICD11_LOCAL_FIRST_CONCEPT_THRESHOLD;
}

async function assertSystemEnabledForTenant({ tenantId, systemKey }) {
  const enabled = await isTerminologySystemEnabledForTenant(tenantId, systemKey);
  if (!enabled) {
    throw AppError.badRequest(
      `Terminology system '${systemKey}' is disabled for this tenant`,
      'TERMINOLOGY_SYSTEM_DISABLED',
    );
  }
}

async function whoIcd11Search({ query, limit }) {
  const concepts = await whoIcdClient.searchIcd11(query, { limit });
  await cacheIcd11Concepts(concepts);
  return concepts.map((concept, index) => ({
    system_key: 'ICD11',
    code: concept.code,
    display: concept.display,
    category: concept.category,
    semantic_tag: concept.semantic_tag,
    status: concept.status || 'active',
    match_rank: index,
    release_id: concept.release_id,
    language: concept.language,
    linearization_uri: concept.linearization_uri,
    foundation_uri: concept.foundation_uri,
    source: 'who_icd_api',
  }));
}

// ── Code systems ───────────────────────────────────────────────────────────

export async function listCodeSystems() {
  return prismaReadOnly.$queryRawUnsafe(
    `SELECT system_key, uri, name, version, source, license_note,
            concept_count, imported_at, is_active
       FROM terminology_code_systems
      ORDER BY system_key`,
  );
}

// ── Concepts ───────────────────────────────────────────────────────────────

/**
 * Ranked concept search within one system: exact code match first, then
 * display-prefix matches, then substring matches; shorter displays first
 * inside each rank so "Fever" outranks "Fever with chills".
 */
export async function searchConcepts({ system, q, limit, tenantId = null } = {}) {
  const systemKey = requireSystemKey(system);
  await assertSystemEnabledForTenant({ tenantId, systemKey });
  const query = q == null ? '' : String(q).trim();
  if (query.length < 2) {
    throw AppError.badRequest('Search text must be at least 2 characters', 'TERMINOLOGY_QUERY_TOO_SHORT');
  }
  const max = clampLimit(limit);
  if (systemKey === 'ICD11' && whoIcdClient.isConfigured()) {
    if (await shouldSearchIcd11LocalFirst()) {
      const local = await localSearchConcepts({ systemKey, query, limit: max });
      if (local.length > 0) return local;
      try {
        return await whoIcd11Search({ query, limit: max });
      } catch (err) {
        logger.warn('WHO ICD-11 search failed after local miss', {
          message: err?.message,
          status: err?.status,
        });
        return local;
      }
    }

    try {
      return await whoIcd11Search({ query, limit: max });
    } catch (err) {
      logger.warn('WHO ICD-11 search failed; falling back to local cache', {
        message: err?.message,
        status: err?.status,
      });
    }
  }
  return localSearchConcepts({ systemKey, query, limit: max });
}

export async function getConcept(system, code) {
  const systemKey = requireSystemKey(system);
  const cleaned = code == null ? '' : String(code).trim();
  if (!cleaned) return null;
  const rows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT system_key, code, display, category, semantic_tag, status, properties
       FROM terminology_concepts
      WHERE system_key = $1 AND lower(code) = lower($2)
      LIMIT 1`,
    systemKey,
    cleaned,
  );
  if (rows[0]) return rows[0];
  if (systemKey === 'ICD11' && whoIcdClient.isConfigured()) {
    try {
      const concept = await whoIcdClient.lookupIcd11Code(cleaned);
      const cached = await cacheIcd11Concepts([concept]);
      return cached[0] || concept || null;
    } catch (err) {
      if (err?.status === 404) return null;
      logger.warn('WHO ICD-11 lookup failed; falling back to local miss', {
        code: cleaned,
        message: err?.message,
        status: err?.status,
      });
    }
  }
  return null;
}

/**
 * Validate a code against the imported catalogue.
 *
 * Modes:
 *   'catalog'    — system has imported concepts; verdict is authoritative.
 *   'structural' — LOINC only, catalogue not imported yet: falls back to the
 *                  structural validator (existing HL7 ingestion behaviour).
 *   'unimported' — system has no imported concepts and no structural
 *                  fallback; valid=false with reason 'system_not_imported'
 *                  so callers can choose to warn rather than block.
 */
export async function validateCode(system, code) {
  const systemKey = requireSystemKey(system);
  const cleaned = code == null ? '' : String(code).trim();
  if (!cleaned) {
    return { valid: false, mode: 'catalog', reason: 'empty_code', concept: null };
  }

  const concept = await getConcept(systemKey, cleaned);
  if (concept) {
    const active = concept.status === 'active';
    return {
      valid: active,
      mode: 'catalog',
      reason: active ? null : `concept_${concept.status}`,
      concept,
    };
  }

  const conceptCount = await conceptCountForSystem(systemKey);
  if (conceptCount > 0) {
    return { valid: false, mode: 'catalog', reason: 'code_not_found', concept: null };
  }
  if (systemKey === 'LOINC') {
    const structurallyValid = isValidLoincStructure(cleaned);
    return {
      valid: structurallyValid,
      mode: 'structural',
      reason: structurallyValid ? 'catalog_not_imported_structural_pass' : 'invalid_structure',
      concept: null,
    };
  }
  return { valid: false, mode: 'unimported', reason: 'system_not_imported', concept: null };
}

// ── Concept maps ───────────────────────────────────────────────────────────

const REVERSED_RELATIONSHIP = Object.freeze({
  equivalent: 'equivalent',
  broader: 'narrower',
  narrower: 'broader',
  related: 'related',
});

export async function mapCode({ fromSystem, code, toSystem, includeReverse = true } = {}) {
  const sourceSystem = requireSystemKey(fromSystem);
  const targetSystem = requireSystemKey(toSystem);
  const cleaned = code == null ? '' : String(code).trim();
  if (!cleaned) throw AppError.badRequest('code is required', 'TERMINOLOGY_CODE_REQUIRED');

  const forward = await prismaReadOnly.$queryRawUnsafe(
    `SELECT m.target_system AS system_key, m.target_code AS code, m.relationship, m.context,
            c.display, c.status
       FROM terminology_concept_maps m
       LEFT JOIN terminology_concepts c
              ON c.system_key = m.target_system AND c.code = m.target_code
      WHERE m.source_system = $1 AND lower(m.source_code) = lower($2) AND m.target_system = $3
      ORDER BY m.relationship, m.target_code`,
    sourceSystem,
    cleaned,
    targetSystem,
  );
  if (forward.length > 0 || !includeReverse) {
    return { source: { system: sourceSystem, code: cleaned }, target_system: targetSystem, mappings: forward };
  }

  // No forward rows — walk reverse edges (target→source) with the
  // relationship inverted, so a single stored direction serves both lookups.
  const reverse = await prismaReadOnly.$queryRawUnsafe(
    `SELECT m.source_system AS system_key, m.source_code AS code, m.relationship, m.context,
            c.display, c.status
       FROM terminology_concept_maps m
       LEFT JOIN terminology_concepts c
              ON c.system_key = m.source_system AND c.code = m.source_code
      WHERE m.target_system = $1 AND lower(m.target_code) = lower($2) AND m.source_system = $3
      ORDER BY m.relationship, m.source_code`,
    sourceSystem,
    cleaned,
    targetSystem,
  );
  const mappings = reverse.map((row) => ({
    ...row,
    relationship: REVERSED_RELATIONSHIP[row.relationship] || row.relationship,
  }));
  return { source: { system: sourceSystem, code: cleaned }, target_system: targetSystem, mappings };
}

export async function upsertConceptMap({
  fromSystem, fromCode, toSystem, toCode, relationship = 'equivalent', context = null, createdBy = null,
} = {}) {
  const sourceSystem = requireSystemKey(fromSystem);
  const targetSystem = requireSystemKey(toSystem);
  const sourceCode = fromCode == null ? '' : String(fromCode).trim();
  const targetCode = toCode == null ? '' : String(toCode).trim();
  if (!sourceCode || !targetCode) {
    throw AppError.badRequest('Both from_code and to_code are required', 'TERMINOLOGY_MAP_CODES_REQUIRED');
  }
  if (!Object.keys(REVERSED_RELATIONSHIP).includes(relationship)) {
    throw AppError.badRequest(
      `relationship must be one of ${Object.keys(REVERSED_RELATIONSHIP).join(', ')}`,
      'TERMINOLOGY_MAP_BAD_RELATIONSHIP',
    );
  }
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO terminology_concept_maps
       (source_system, source_code, target_system, target_code, relationship, context, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::uuid)
     ON CONFLICT (source_system, source_code, target_system, target_code, relationship)
     DO UPDATE SET context = EXCLUDED.context
     RETURNING id::text AS id, source_system, source_code, target_system, target_code,
               relationship, context, created_by, created_at`,
    sourceSystem,
    sourceCode,
    targetSystem,
    targetCode,
    relationship,
    context,
    createdBy,
  );
  return rows[0];
}

// ── Catalog bindings ───────────────────────────────────────────────────────

export async function bindCatalogItem({
  catalogType, catalogId, system, code, display = null,
  bindingStatus = 'confirmed', confidence = null, boundBy = null, allowUnknownCode = false,
} = {}) {
  requireCatalogTarget(catalogType);
  const systemKey = requireSystemKey(system);
  const cleanedCode = code == null ? '' : String(code).trim();
  const id = Number.parseInt(catalogId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('catalog_id must be a positive integer', 'TERMINOLOGY_BAD_CATALOG_ID');
  }
  if (!cleanedCode) throw AppError.badRequest('code is required', 'TERMINOLOGY_CODE_REQUIRED');
  if (!['suggested', 'confirmed', 'rejected'].includes(bindingStatus)) {
    throw AppError.badRequest('binding_status must be suggested|confirmed|rejected', 'TERMINOLOGY_BAD_BINDING_STATUS');
  }

  let resolvedDisplay = display;
  const concept = await getConcept(systemKey, cleanedCode);
  if (concept) {
    resolvedDisplay = resolvedDisplay || concept.display;
  } else if (!allowUnknownCode) {
    const verdict = await validateCode(systemKey, cleanedCode);
    if (!verdict.valid) {
      throw AppError.badRequest(
        `Code '${cleanedCode}' is not a known active ${systemKey} concept (${verdict.reason}). ` +
          'Import the code system or pass allow_unknown_code=true to bind anyway.',
        'TERMINOLOGY_UNKNOWN_CODE',
      );
    }
  }

  const verified = bindingStatus === 'confirmed';
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO terminology_catalog_bindings
       (catalog_type, catalog_id, system_key, code, display, binding_status, confidence, bound_by,
        verified_by, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid,
             CASE WHEN $9 THEN $8::uuid ELSE NULL END,
             CASE WHEN $9 THEN NOW() ELSE NULL END)
     ON CONFLICT (catalog_type, catalog_id, system_key)
     DO UPDATE SET
       code = EXCLUDED.code,
       display = EXCLUDED.display,
       binding_status = EXCLUDED.binding_status,
       confidence = EXCLUDED.confidence,
       bound_by = COALESCE(EXCLUDED.bound_by, terminology_catalog_bindings.bound_by),
       verified_by = CASE WHEN $9 THEN EXCLUDED.verified_by ELSE terminology_catalog_bindings.verified_by END,
       verified_at = CASE WHEN $9 THEN NOW() ELSE terminology_catalog_bindings.verified_at END,
       updated_at = NOW()
     RETURNING *`,
    catalogType,
    id,
    systemKey,
    cleanedCode,
    resolvedDisplay,
    bindingStatus,
    confidence,
    boundBy,
    verified,
  );
  return rows[0];
}

export async function listCatalogBindings({ catalogType, catalogId } = {}) {
  requireCatalogTarget(catalogType);
  const id = Number.parseInt(catalogId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw AppError.badRequest('catalog_id must be a positive integer', 'TERMINOLOGY_BAD_CATALOG_ID');
  }
  return prismaReadOnly.$queryRawUnsafe(
    `SELECT id, catalog_type, catalog_id, system_key, code, display, binding_status,
            confidence, bound_by, verified_by, verified_at, created_at, updated_at
       FROM terminology_catalog_bindings
      WHERE catalog_type = $1 AND catalog_id = $2
      ORDER BY system_key`,
    catalogType,
    id,
  );
}

/**
 * Pure matcher used by suggestCatalogBindings — exported for unit tests.
 * Exact case-insensitive name↔display equality scores 1.0; a display that
 * starts with the name (or vice versa) scores 0.8; otherwise no suggestion.
 */
export function scoreNameMatch(catalogName, conceptDisplay) {
  const a = (catalogName || '').trim().toLowerCase();
  const b = (conceptDisplay || '').trim().toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.8;
  return 0;
}

/**
 * Suggest standard-code bindings for unbound catalog rows by exact/prefix
 * name match against imported concepts. Read-only by default; with
 * { persist: true } the suggestions are written as binding_status='suggested'
 * rows for a curator to confirm.
 */
export async function suggestCatalogBindings({ catalogType, system = null, limit = 50, persist = false, boundBy = null } = {}) {
  const target = requireCatalogTarget(catalogType);
  const systemKey = requireSystemKey(system || target.defaultSystem);
  const max = clampLimit(limit, 50, 200);

  // nameColumns are fixed identifiers from CATALOG_TARGETS (not user input).
  const nameExpr = target.nameColumns.length > 1
    ? `COALESCE(${target.nameColumns.join(', ')})`
    : target.nameColumns[0];

  const rows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT cat.id AS catalog_id, ${nameExpr} AS catalog_name,
            tc.code, tc.display,
            CASE WHEN lower(${nameExpr}) = lower(tc.display) THEN 1.0 ELSE 0.8 END AS confidence
       FROM ${target.table} cat
       JOIN terminology_concepts tc
         ON tc.system_key = $1
        AND tc.status = 'active'
        AND (lower(tc.display) = lower(${nameExpr})
             OR lower(tc.display) LIKE lower(${nameExpr}) || ' %')
      WHERE NOT EXISTS (
              SELECT 1 FROM terminology_catalog_bindings b
               WHERE b.catalog_type = $2 AND b.catalog_id = cat.id AND b.system_key = $1
            )
        AND ${nameExpr} IS NOT NULL
      ORDER BY confidence DESC, cat.id
      LIMIT $3::int`,
    systemKey,
    catalogType,
    max,
  );

  const suggestions = rows.map((row) => ({
    catalog_type: catalogType,
    catalog_id: Number(row.catalog_id),
    catalog_name: row.catalog_name,
    system_key: systemKey,
    code: row.code,
    display: row.display,
    confidence: Number(row.confidence),
  }));

  if (persist && suggestions.length > 0) {
    for (const s of suggestions) {
      // Sequential upserts keep this simple; suggestion volume is curator-
      // driven and bounded by `limit`.
      await bindCatalogItem({
        catalogType,
        catalogId: s.catalog_id,
        system: systemKey,
        code: s.code,
        display: s.display,
        bindingStatus: 'suggested',
        confidence: s.confidence,
        boundBy,
      });
    }
    logger.info('Terminology binding suggestions persisted', {
      catalogType, systemKey, count: suggestions.length,
    });
  }
  return suggestions;
}

/**
 * Coverage report — how much of each local catalog carries a confirmed
 * standard-code binding. The roadmap-B8 exit metric.
 */
export async function coverageReport() {
  const catalogBindings = [];
  for (const [catalogType, target] of Object.entries(CATALOG_TARGETS)) {
    const rows = await prismaReadOnly.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::int FROM ${target.table}) AS catalog_rows,
         COUNT(*) FILTER (WHERE b.binding_status = 'confirmed')::int AS confirmed,
         COUNT(*) FILTER (WHERE b.binding_status = 'suggested')::int AS suggested,
         COUNT(*) FILTER (WHERE b.binding_status = 'rejected')::int  AS rejected
       FROM terminology_catalog_bindings b
       WHERE b.catalog_type = $1`,
      catalogType,
    );
    const row = rows[0] || {};
    const catalogRows = Number(row.catalog_rows) || 0;
    const confirmed = Number(row.confirmed) || 0;
    catalogBindings.push({
      catalog_type: catalogType,
      table: target.table,
      default_system: target.defaultSystem,
      catalog_rows: catalogRows,
      confirmed,
      suggested: Number(row.suggested) || 0,
      rejected: Number(row.rejected) || 0,
      confirmed_pct: catalogRows > 0 ? Math.round((confirmed / catalogRows) * 1000) / 10 : 0,
    });
  }

  const mapRows = await prismaReadOnly.$queryRawUnsafe(
    `SELECT source_system, target_system,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE relationship = 'equivalent')::int AS equivalent,
            COUNT(*) FILTER (WHERE relationship = 'broader')::int AS broader,
            COUNT(*) FILTER (WHERE relationship = 'narrower')::int AS narrower,
            COUNT(*) FILTER (WHERE relationship = 'related')::int AS related
       FROM terminology_concept_maps
      GROUP BY source_system, target_system
      ORDER BY source_system, target_system`,
  );

  const conceptMaps = mapRows.map((row) => ({
    source_system: row.source_system,
    target_system: row.target_system,
    total: Number(row.total) || 0,
    relationships: {
      equivalent: Number(row.equivalent) || 0,
      broader: Number(row.broader) || 0,
      narrower: Number(row.narrower) || 0,
      related: Number(row.related) || 0,
    },
  }));

  return {
    catalog_bindings: catalogBindings,
    concept_maps: conceptMaps,
  };
}

export default {
  SYSTEM_KEYS,
  ICD11_LOCAL_FIRST_CONCEPT_THRESHOLD,
  CATALOG_TARGETS,
  normalizeSystemKey,
  listCodeSystems,
  searchConcepts,
  getConcept,
  validateCode,
  mapCode,
  upsertConceptMap,
  bindCatalogItem,
  listCatalogBindings,
  scoreNameMatch,
  suggestCatalogBindings,
  coverageReport,
};
