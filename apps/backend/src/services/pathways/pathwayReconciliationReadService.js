import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { CANONICAL_PATHWAY_KEYS } from './pathwayMode.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESULT_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,119}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000;

function integerInRange(value, fallback, min, max, label) {
  const candidate = value === undefined || value === null || value === ''
    ? fallback
    : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    throw AppError.badRequest(`${label} is invalid`, 'PATHWAY_RECONCILIATION_QUERY_INVALID');
  }
  return candidate;
}

function requireTenantId(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw AppError.forbidden(
      'Tenant-scoped reconciliation access is required',
      'TENANT_CONTEXT_REQUIRED',
    );
  }
  return normalized;
}

function pathwayKey(value) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim();
  if (!CANONICAL_PATHWAY_KEYS.includes(normalized)) {
    throw AppError.badRequest(
      'pathway_key is invalid',
      'PATHWAY_RECONCILIATION_QUERY_INVALID',
    );
  }
  return normalized;
}

function safeCount(value) {
  const candidate = Number(value ?? 0);
  return Number.isSafeInteger(candidate) && candidate >= 0 ? candidate : 0;
}

function safeResults(value) {
  const rows = Array.isArray(value) ? value : [];
  return rows.slice(0, 200).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || !RESULT_CODE_PATTERN.test(entry.code)) return [];
    return [{
      code: entry.code,
      finding_count: safeCount(entry.finding_count),
      repair_count: safeCount(entry.repair_count),
      error_count: safeCount(entry.error_count),
    }];
  });
}

export function sanitizePathwayReconciliationEvidence(row) {
  return {
    id: String(row.id),
    sweep_id: String(row.sweep_id),
    pathway_key: row.pathway_key,
    pathway_mode: row.pathway_mode,
    registry_version: Number(row.registry_version),
    registry_checksum: row.registry_checksum,
    governance_checksum: row.governance_checksum,
    governance_count: Number(row.governance_count),
    covered_governance_count: Number(row.covered_governance_count),
    expected_check_count: Number(row.expected_check_count),
    executed_check_count: Number(row.executed_check_count),
    finding_count: Number(row.finding_count),
    repair_count: Number(row.repair_count),
    error_count: Number(row.error_count),
    registry_complete: row.registry_complete === true,
    passed: row.passed === true,
    check_results: safeResults(row.check_results),
    started_at: row.started_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
  };
}

const SELECT_COLUMNS = `id::text, sweep_id, pathway_key, pathway_mode,
  registry_version, registry_checksum, governance_checksum,
  governance_count, covered_governance_count,
  expected_check_count, executed_check_count,
  finding_count, repair_count, error_count,
  registry_complete, passed, check_results,
  started_at, completed_at, created_at`;

async function listLatestTx(tx, tenant, key, limit, offset) {
  return tx.$queryRawUnsafe(
    `SELECT ${SELECT_COLUMNS}
       FROM (
         SELECT DISTINCT ON (pathway_key) *
           FROM care_pathway_reconciliation_checks
          WHERE tenant_id = $1::uuid
            AND ($2::text IS NULL OR pathway_key = $2::text)
          ORDER BY pathway_key, completed_at DESC, id DESC
       ) AS latest
      ORDER BY pathway_key
      LIMIT $3::integer OFFSET $4::integer`,
    tenant,
    key,
    limit,
    offset,
  );
}

async function listHistoryTx(tx, tenant, key, limit, offset) {
  return tx.$queryRawUnsafe(
    `SELECT ${SELECT_COLUMNS}
       FROM care_pathway_reconciliation_checks
      WHERE tenant_id = $1::uuid
        AND ($2::text IS NULL OR pathway_key = $2::text)
      ORDER BY completed_at DESC, id DESC
      LIMIT $3::integer OFFSET $4::integer`,
    tenant,
    key,
    limit,
    offset,
  );
}

export async function listPathwayReconciliationEvidence({
  tenantId,
  pathwayKey: requestedPathwayKey = null,
  view = 'latest',
  limit = DEFAULT_LIMIT,
  offset = 0,
} = {}) {
  const normalizedTenantId = requireTenantId(tenantId);
  const normalizedPathwayKey = pathwayKey(requestedPathwayKey);
  if (!['latest', 'history'].includes(view)) {
    throw AppError.badRequest('view is invalid', 'PATHWAY_RECONCILIATION_QUERY_INVALID');
  }
  const normalizedLimit = integerInRange(limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
  const normalizedOffset = integerInRange(offset, 0, 0, MAX_OFFSET, 'offset');
  const rows = await setTenantTx(normalizedTenantId, (tx) => (
    view === 'latest'
      ? listLatestTx(tx, normalizedTenantId, normalizedPathwayKey, normalizedLimit, normalizedOffset)
      : listHistoryTx(tx, normalizedTenantId, normalizedPathwayKey, normalizedLimit, normalizedOffset)
  ));
  return Object.freeze({
    evidence: Object.freeze(rows.map(sanitizePathwayReconciliationEvidence)),
    count: rows.length,
    limit: normalizedLimit,
    offset: normalizedOffset,
  });
}

export default {
  listPathwayReconciliationEvidence,
  sanitizePathwayReconciliationEvidence,
};
