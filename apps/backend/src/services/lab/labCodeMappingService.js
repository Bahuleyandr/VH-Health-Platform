// src/services/lab/labCodeMappingService.js
//
// Terminology slate C1 / WP3 — analyzer/interface code → catalog/LOINC
// mapping layer (migration 721).
//
// Two consumers:
//   1. Curator CRUD + coverage under /api/v1/lab/code-mappings
//      (routes/lab/labCodeMappingRoutes.js, curator-role gated).
//   2. Dark ingest-time enrichment: the ORU (labResultsService) and ASTM
//      (labClosedLoopService) ingest paths call
//      applyLoincMappingEnrichment() to stamp lab_results.loinc_code when
//      the analyzer did not assert a LOINC itself.
//
// Enrichment is gated by LAB_LOINC_MAPPING_ENABLED (env kill switch,
// default off) AND tenant settings.labLoincMapping.enabled (default off)
// AND requires curated active rows. All three default to "off"/absent, so
// stock deployments behave byte-identically. Enrichment is FAIL-OPEN by
// contract: no mapping-layer failure may ever block result ingestion —
// every DB touch here runs on the plain prisma pool (never a caller's tx
// client) so a failed lookup cannot abort the surrounding clinical
// transaction, and every entry point catches and logs instead of throwing.
//
// Tenant scoping is fail-closed on every query: explicit
// `tenant_id = $1::uuid` predicates (house pattern), and a missing tenant
// context throws before any SQL runs.

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { isValidStructure as isValidLoincStructure } from '../hl7/loincValidator.js';

const MAPPING_COLUMNS = `id, tenant_id, source_key, incoming_code, incoming_code_system,
       catalog_id, loinc_code, display, active, verified_by, verified_at,
       created_by, created_at, updated_at`;

const ANY_SOURCE_KEY = 'any';
const RESOLVER_CACHE_TTL_MS = 60 * 1000;
const COVERAGE_DEFAULT_DAYS = 30;
const COVERAGE_MAX_DAYS = 365;
const TOP_UNMAPPED_LIMIT = 25;

// keyed `${tenantId}|${SOURCE_KEY_UPPER}` → { loadedAt, byCode: Map }
let resolverCache = new Map();

/** Test/ops hook — drop every cached resolver. Writes call this too. */
export function _invalidateLabCodeMappingCache() {
  resolverCache = new Map();
}

function requireTenant(tenantId) {
  // Deliberately stricter than tenantService.requireTenantId — the mapping
  // layer never has a default-tenant fallback; callers (lab routes + ingest
  // paths) always carry a resolved tenant.
  if (!tenantId) {
    throw AppError.forbidden('Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  }
  return String(tenantId);
}

export function isLabLoincMappingEnvEnabled() {
  return String(process.env.LAB_LOINC_MAPPING_ENABLED || '').trim().toLowerCase() === 'true';
}

/**
 * Effective gate = env kill switch AND tenant flag. Returns the layered
 * shape so the coverage endpoint (and later the WP5 console) can show which
 * layer is blocking. Never throws on settings problems — a malformed or
 * unreadable settings row reads as disabled (feature-dormant fail-open).
 */
export async function resolveLabLoincMappingGate(tenantId) {
  const env = isLabLoincMappingEnvEnabled();
  if (!env) return { env: false, tenant: false, effective: false };
  let tenant = false;
  try {
    // Dynamic import on purpose: keeps the tenantSettingsService accessor
    // out of the static import graph of the lab ingest services (jest
    // unstable_mockModule factories that mock tenantSettingsService without
    // the new export would otherwise fail suites at load).
    const { getLabLoincMappingSettings } = await import('../tenant/tenantSettingsService.js');
    const settings = await getLabLoincMappingSettings(requireTenant(tenantId));
    tenant = settings.enabled === true;
  } catch (err) {
    logger.warn('LOINC mapping tenant gate read failed — treating as disabled', {
      tenantId, error: err?.message,
    });
  }
  return { env, tenant, effective: env && tenant };
}

function normalizeSourceKey(value, { fallback = null } = {}) {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  if (text.length > 120) return text.slice(0, 120);
  return text;
}

function normalizeIncomingCode(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 120) return null;
  return text;
}

function normalizeLoincCode(value) {
  if (value == null || String(value).trim() === '') return { ok: true, value: null };
  const text = String(value).trim();
  if (!isValidLoincStructure(text)) return { ok: false, value: null };
  return { ok: true, value: text };
}

async function assertCatalogRowExists(catalogId) {
  // investigation_test_catalog is a global catalog (no tenant_id column).
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id FROM investigation_test_catalog WHERE id = $1::bigint LIMIT 1',
    Number(catalogId),
  );
  if (!rows[0]) {
    throw AppError.badRequest(
      'catalog_id does not match any investigation_test_catalog row',
      'LAB_CODE_MAPPING_CATALOG_NOT_FOUND',
    );
  }
}

function serializeMapping(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    source_key: row.source_key,
    incoming_code: row.incoming_code,
    incoming_code_system: row.incoming_code_system ?? null,
    catalog_id: row.catalog_id == null ? null : Number(row.catalog_id),
    loinc_code: row.loinc_code ?? null,
    display: row.display ?? null,
    active: row.active === true,
    verified_by: row.verified_by ?? null,
    verified_at: row.verified_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function clampLimit(value, fallback = 50, max = 200) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function requireMappingId(id) {
  const parsed = Number.parseInt(id, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest('mapping id must be a positive integer', 'LAB_CODE_MAPPING_BAD_ID');
  }
  return parsed;
}

// ── CRUD ──────────────────────────────────────────────────────────────────

export async function listMappings({
  tenantId, sourceKey = null, q = null, includeInactive = false, limit = 50, offset = 0,
} = {}) {
  const tenant = requireTenant(tenantId);
  const params = [tenant];
  const where = ['tenant_id = $1::uuid'];
  if (!includeInactive) where.push('active = TRUE');
  const source = normalizeSourceKey(sourceKey);
  if (source) {
    params.push(source);
    where.push(`UPPER(source_key) = UPPER($${params.length})`);
  }
  const query = String(q ?? '').trim();
  if (query) {
    params.push(`%${query}%`);
    where.push(`(incoming_code ILIKE $${params.length} OR display ILIKE $${params.length} OR loinc_code ILIKE $${params.length})`);
  }
  params.push(clampLimit(limit));
  const limitIdx = params.length;
  const offsetParsed = Number.parseInt(offset, 10);
  params.push(Number.isInteger(offsetParsed) && offsetParsed > 0 ? offsetParsed : 0);
  const offsetIdx = params.length;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${MAPPING_COLUMNS}
       FROM lab_analyzer_code_mappings
      WHERE ${where.join(' AND ')}
      ORDER BY source_key ASC, UPPER(incoming_code) ASC, id ASC
      LIMIT $${limitIdx}::int OFFSET $${offsetIdx}::int`,
    ...params,
  );
  return { mappings: rows.map(serializeMapping), count: rows.length };
}

export async function getMapping({ tenantId, id } = {}) {
  const tenant = requireTenant(tenantId);
  const mappingId = requireMappingId(id);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT ${MAPPING_COLUMNS}
       FROM lab_analyzer_code_mappings
      WHERE tenant_id = $1::uuid AND id = $2::bigint
      LIMIT 1`,
    tenant,
    mappingId,
  );
  if (!rows[0]) throw AppError.notFound('Lab code mapping not found', 'LAB_CODE_MAPPING_NOT_FOUND');
  return serializeMapping(rows[0]);
}

export async function createMapping({ tenantId, actorUid = null, mapping = {} } = {}) {
  const tenant = requireTenant(tenantId);
  const incomingCode = normalizeIncomingCode(mapping.incoming_code);
  if (!incomingCode) {
    throw AppError.badRequest(
      'incoming_code is required (max 120 chars)',
      'LAB_CODE_MAPPING_CODE_REQUIRED',
    );
  }
  const sourceKey = normalizeSourceKey(mapping.source_key, { fallback: ANY_SOURCE_KEY });
  const loinc = normalizeLoincCode(mapping.loinc_code);
  if (!loinc.ok) {
    throw AppError.badRequest(
      'loinc_code is not structurally valid (expected <digits>-<check digit>)',
      'LAB_CODE_MAPPING_LOINC_INVALID',
    );
  }
  const catalogId = mapping.catalog_id == null || mapping.catalog_id === ''
    ? null
    : Number.parseInt(mapping.catalog_id, 10);
  if (catalogId != null && (!Number.isInteger(catalogId) || catalogId <= 0)) {
    throw AppError.badRequest('catalog_id must be a positive integer', 'LAB_CODE_MAPPING_BAD_CATALOG_ID');
  }
  if (catalogId == null && loinc.value == null) {
    throw AppError.badRequest(
      'A mapping requires a catalog_id, a loinc_code, or both',
      'LAB_CODE_MAPPING_TARGET_REQUIRED',
    );
  }
  if (catalogId != null) await assertCatalogRowExists(catalogId);

  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO lab_analyzer_code_mappings
         (tenant_id, source_key, incoming_code, incoming_code_system,
          catalog_id, loinc_code, display, active, created_by)
       VALUES ($1::uuid, $2, $3, $4, $5::bigint, $6, $7, TRUE, $8::uuid)
       RETURNING ${MAPPING_COLUMNS}`,
      tenant,
      sourceKey,
      incomingCode,
      String(mapping.incoming_code_system ?? '').trim().slice(0, 80) || null,
      catalogId,
      loinc.value,
      String(mapping.display ?? '').trim().slice(0, 2000) || null,
      actorUid || null,
    );
    _invalidateLabCodeMappingCache();
    return serializeMapping(rows[0]);
  } catch (err) {
    if (err?.code === 'P2010' && String(err?.meta?.code) === '23505') {
      throw AppError.conflict(
        'An active mapping for this source and incoming code already exists',
        'LAB_CODE_MAPPING_DUPLICATE',
      );
    }
    if (String(err?.code) === '23505' || String(err?.message || '').includes('ux_lab_analyzer_code_mappings_live')) {
      throw AppError.conflict(
        'An active mapping for this source and incoming code already exists',
        'LAB_CODE_MAPPING_DUPLICATE',
      );
    }
    throw err;
  }
}

export async function updateMapping({ tenantId, id, actorUid = null, patch = {} } = {}) {
  const tenant = requireTenant(tenantId);
  const mappingId = requireMappingId(id);
  const sets = [];
  const params = [tenant, mappingId];
  const push = (fragment, value) => {
    params.push(value);
    sets.push(fragment.replace('$N', `$${params.length}`));
  };

  if (patch.incoming_code !== undefined) {
    const incomingCode = normalizeIncomingCode(patch.incoming_code);
    if (!incomingCode) {
      throw AppError.badRequest('incoming_code must be non-empty (max 120 chars)', 'LAB_CODE_MAPPING_CODE_REQUIRED');
    }
    push('incoming_code = $N', incomingCode);
  }
  if (patch.source_key !== undefined) {
    const sourceKey = normalizeSourceKey(patch.source_key);
    if (!sourceKey) {
      throw AppError.badRequest('source_key must be non-empty', 'LAB_CODE_MAPPING_SOURCE_REQUIRED');
    }
    push('source_key = $N', sourceKey);
  }
  if (patch.incoming_code_system !== undefined) {
    push('incoming_code_system = $N', String(patch.incoming_code_system ?? '').trim().slice(0, 80) || null);
  }
  if (patch.loinc_code !== undefined) {
    const loinc = normalizeLoincCode(patch.loinc_code);
    if (!loinc.ok) {
      throw AppError.badRequest(
        'loinc_code is not structurally valid (expected <digits>-<check digit>)',
        'LAB_CODE_MAPPING_LOINC_INVALID',
      );
    }
    push('loinc_code = $N', loinc.value);
  }
  if (patch.catalog_id !== undefined) {
    const catalogId = patch.catalog_id == null || patch.catalog_id === ''
      ? null
      : Number.parseInt(patch.catalog_id, 10);
    if (catalogId != null) {
      if (!Number.isInteger(catalogId) || catalogId <= 0) {
        throw AppError.badRequest('catalog_id must be a positive integer', 'LAB_CODE_MAPPING_BAD_CATALOG_ID');
      }
      await assertCatalogRowExists(catalogId);
    }
    push('catalog_id = $N::bigint', catalogId);
  }
  if (patch.display !== undefined) {
    push('display = $N', String(patch.display ?? '').trim().slice(0, 2000) || null);
  }
  if (patch.active !== undefined) {
    push('active = $N::boolean', patch.active === true);
  }
  if (patch.verified !== undefined) {
    if (patch.verified === true) {
      push('verified_by = $N::uuid', actorUid || null);
      sets.push('verified_at = NOW()');
    } else {
      sets.push('verified_by = NULL');
      sets.push('verified_at = NULL');
    }
  }
  if (!sets.length) {
    throw AppError.badRequest('No updatable fields were supplied', 'LAB_CODE_MAPPING_EMPTY_PATCH');
  }
  sets.push('updated_at = NOW()');

  try {
    const rows = await prisma.$queryRawUnsafe(
      `UPDATE lab_analyzer_code_mappings
          SET ${sets.join(', ')}
        WHERE tenant_id = $1::uuid AND id = $2::bigint
        RETURNING ${MAPPING_COLUMNS}`,
      ...params,
    );
    if (!rows[0]) throw AppError.notFound('Lab code mapping not found', 'LAB_CODE_MAPPING_NOT_FOUND');
    _invalidateLabCodeMappingCache();
    return serializeMapping(rows[0]);
  } catch (err) {
    if (String(err?.code) === '23514' || String(err?.message || '').includes('chk_lab_analyzer_code_mappings_target')) {
      throw AppError.badRequest(
        'A mapping requires a catalog_id, a loinc_code, or both',
        'LAB_CODE_MAPPING_TARGET_REQUIRED',
      );
    }
    if (String(err?.code) === '23505' || String(err?.message || '').includes('ux_lab_analyzer_code_mappings_live')) {
      throw AppError.conflict(
        'An active mapping for this source and incoming code already exists',
        'LAB_CODE_MAPPING_DUPLICATE',
      );
    }
    throw err;
  }
}

/** DELETE = deactivate. History rows stay for audit; the live-unique index
 * frees the (tenant, source, code) slot for a corrected replacement. */
export async function deactivateMapping({ tenantId, id, actorUid = null } = {}) {
  return updateMapping({ tenantId, id, actorUid, patch: { active: false } });
}

// ── Resolver (ingest side) ────────────────────────────────────────────────

function resolverCacheKey(tenantId, sourceKey) {
  return `${tenantId}|${String(sourceKey || ANY_SOURCE_KEY).trim().toUpperCase()}`;
}

async function loadResolverEntries(tenantId, sourceKey) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT m.id, m.source_key, m.incoming_code, m.catalog_id, m.loinc_code, m.display,
            b.code AS catalog_loinc_code
       FROM lab_analyzer_code_mappings m
       LEFT JOIN terminology_catalog_bindings b
         ON b.catalog_type = 'investigation_test'
        AND b.catalog_id = m.catalog_id
        AND b.system_key = 'LOINC'
        AND b.binding_status = 'confirmed'
      WHERE m.tenant_id = $1::uuid
        AND m.active = TRUE
        AND (UPPER(m.source_key) = UPPER($2) OR m.source_key = $3)`,
    tenantId,
    String(sourceKey || ANY_SOURCE_KEY).trim(),
    ANY_SOURCE_KEY,
  );
  const byCode = new Map();
  for (const row of rows) {
    const codeKey = String(row.incoming_code || '').trim().toUpperCase();
    if (!codeKey) continue;
    const isWildcard = String(row.source_key) === ANY_SOURCE_KEY;
    const current = byCode.get(codeKey);
    // Source-specific rows win over the 'any' wildcard.
    if (current && !current.isWildcard && isWildcard) continue;
    byCode.set(codeKey, {
      isWildcard,
      mapping_id: Number(row.id),
      catalog_id: row.catalog_id == null ? null : Number(row.catalog_id),
      display: row.display ?? null,
      loinc_code: row.loinc_code ?? row.catalog_loinc_code ?? null,
    });
  }
  return byCode;
}

/**
 * Builds a pure in-memory resolve(code) → hit|null for one (tenant, source).
 * One DB round trip, TTL-cached. The returned function is synchronous so
 * ingest transactions can consult it without any tx-scoped SQL.
 */
export async function buildLoincResolver({ tenantId, sourceKey = ANY_SOURCE_KEY } = {}) {
  const tenant = requireTenant(tenantId);
  const key = resolverCacheKey(tenant, sourceKey);
  const cached = resolverCache.get(key);
  let byCode;
  if (cached && Date.now() - cached.loadedAt < RESOLVER_CACHE_TTL_MS) {
    byCode = cached.byCode;
  } else {
    byCode = await loadResolverEntries(tenant, sourceKey);
    resolverCache.set(key, { loadedAt: Date.now(), byCode });
  }
  return (code) => {
    const codeKey = String(code ?? '').trim().toUpperCase();
    if (!codeKey) return null;
    return byCode.get(codeKey) || null;
  };
}

/** Single-code convenience wrapper over buildLoincResolver. */
export async function resolveLoincForResult({ tenantId, sourceKey = ANY_SOURCE_KEY, testCode } = {}) {
  const resolve = await buildLoincResolver({ tenantId, sourceKey });
  return resolve(testCode);
}

/**
 * Dark ingest enrichment. Mutates `rows` in place, filling row[loincKey]
 * from the curated mapping when the analyzer did not assert a LOINC.
 *
 * FAIL-OPEN CONTRACT: never throws. Gate off, no rows, resolver failure,
 * settings failure — all return { enriched: 0 } and leave every row exactly
 * as the analyzer sent it. Called OUTSIDE (ORU) or alongside (ASTM, plain
 * pool) the ingest transaction so a mapping-layer SQL failure can never
 * abort the clinical write.
 */
export async function applyLoincMappingEnrichment({
  tenantId, sourceKey, rows, codeKey = 'testCode', loincKey = 'loincCode',
} = {}) {
  try {
    if (!Array.isArray(rows) || rows.length === 0) return { enriched: 0, unmapped: [] };
    if (!isLabLoincMappingEnvEnabled()) return { enriched: 0, unmapped: [] };
    const gate = await resolveLabLoincMappingGate(tenantId);
    if (!gate.effective) return { enriched: 0, unmapped: [] };
    const resolve = await buildLoincResolver({ tenantId, sourceKey });
    let enriched = 0;
    const unmapped = new Set();
    for (const row of rows) {
      if (!row || row[loincKey]) continue;
      const hit = resolve(row[codeKey]);
      if (hit?.loinc_code) {
        row[loincKey] = hit.loinc_code;
        enriched += 1;
      } else {
        const code = String(row[codeKey] ?? '').trim();
        if (code) unmapped.add(code.toUpperCase());
      }
    }
    if (unmapped.size) {
      logger.info('LOINC mapping enrichment: unmapped analyzer codes', {
        tenantId,
        sourceKey: sourceKey || ANY_SOURCE_KEY,
        unmappedCount: unmapped.size,
        unmapped: [...unmapped].slice(0, 50),
      });
    }
    return { enriched, unmapped: [...unmapped] };
  } catch (err) {
    logger.warn('LOINC mapping enrichment skipped (fail-open)', {
      tenantId,
      sourceKey: sourceKey || ANY_SOURCE_KEY,
      error: err?.message,
    });
    return { enriched: 0, unmapped: [], failed: true };
  }
}

// ── Coverage ──────────────────────────────────────────────────────────────

/**
 * Mapping coverage for the curation console (JSON shape frozen for the WP5
 * admin console): inbound analyzer codes seen on lab_results in the window
 * vs curated mappings, plus the investigation catalog's confirmed-LOINC
 * binding rate.
 */
export async function coverageReport({ tenantId, days = COVERAGE_DEFAULT_DAYS } = {}) {
  const tenant = requireTenant(tenantId);
  const parsedDays = Number.parseInt(days, 10);
  const windowDays = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= COVERAGE_MAX_DAYS
    ? parsedDays
    : COVERAGE_DEFAULT_DAYS;

  const [gate, seenRows, mappingRows, catalogRows] = await Promise.all([
    resolveLabLoincMappingGate(tenant),
    prisma.$queryRawUnsafe(
      `WITH seen AS (
         SELECT UPPER(test_code) AS code,
                COUNT(*)::int AS result_count,
                COUNT(*) FILTER (WHERE loinc_code IS NOT NULL)::int AS with_loinc
           FROM lab_results
          WHERE tenant_id = $1::uuid
            AND test_code IS NOT NULL
            AND received_at >= NOW() - make_interval(days => $2::int)
          GROUP BY UPPER(test_code)
       )
       SELECT s.code, s.result_count, s.with_loinc,
              EXISTS (
                SELECT 1 FROM lab_analyzer_code_mappings m
                 WHERE m.tenant_id = $1::uuid
                   AND m.active = TRUE
                   AND UPPER(m.incoming_code) = s.code
              ) AS mapped
         FROM seen s
        ORDER BY s.result_count DESC, s.code ASC`,
      tenant,
      windowDays,
    ),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FILTER (WHERE active)::int AS active,
              COUNT(*) FILTER (WHERE NOT active)::int AS inactive
         FROM lab_analyzer_code_mappings
        WHERE tenant_id = $1::uuid`,
      tenant,
    ),
    prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS active_items,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM terminology_catalog_bindings b
                 WHERE b.catalog_type = 'investigation_test'
                   AND b.catalog_id = c.id
                   AND b.system_key = 'LOINC'
                   AND b.binding_status = 'confirmed'
              ))::int AS loinc_bound
         FROM investigation_test_catalog c
        WHERE c.is_active = TRUE`,
    ),
  ]);

  const distinctCodes = seenRows.length;
  const mappedCodes = seenRows.filter((row) => row.mapped === true).length;
  const resultsTotal = seenRows.reduce((sum, row) => sum + Number(row.result_count || 0), 0);
  const resultsWithLoinc = seenRows.reduce((sum, row) => sum + Number(row.with_loinc || 0), 0);
  const topUnmapped = seenRows
    .filter((row) => row.mapped !== true)
    .slice(0, TOP_UNMAPPED_LIMIT)
    .map((row) => ({ code: row.code, result_count: Number(row.result_count || 0) }));
  const activeItems = Number(catalogRows[0]?.active_items || 0);
  const loincBound = Number(catalogRows[0]?.loinc_bound || 0);

  return {
    enabled: gate,
    window_days: windowDays,
    inbound: {
      distinct_codes: distinctCodes,
      mapped_codes: mappedCodes,
      unmapped_codes: distinctCodes - mappedCodes,
      results_total: resultsTotal,
      results_with_loinc: resultsWithLoinc,
      top_unmapped: topUnmapped,
    },
    mappings: {
      active: Number(mappingRows[0]?.active || 0),
      inactive: Number(mappingRows[0]?.inactive || 0),
    },
    catalog: {
      active_items: activeItems,
      loinc_bound: loincBound,
      loinc_bound_pct: activeItems > 0 ? Math.round((loincBound / activeItems) * 1000) / 10 : 0,
    },
  };
}
