/**
 * ClinicalTrials.gov v2 catalog sync.
 *
 * One clinical_ai_trial_sync_runs row is one complete provider page. The
 * stable canonical query is the partition, and the opaque provider page token
 * plus provider dataTimestamp are the continuation evidence. Local status,
 * timestamps, and NCT upsert counts are never HWM evidence.
 */

import { createHash, randomUUID } from 'node:crypto';

import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { upsertTrial } from './trialMatcherService.js';

const API_URL = 'https://clinicaltrials.gov/api/v2/studies';
const VERSION_URL = 'https://clinicaltrials.gov/api/v2/version';
const DEFAULT_PAGE_SIZE = 50;
const MAX_RUN_SIZE = 200;
const REQUEST_TIMEOUT_MS = 20_000;

function resolveTenantId(options = {}) {
  return requireTenantId(options.tenantId);
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeQueryValue(value) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text || null;
}

function normalizeConditions(values) {
  const unique = new Map();
  for (const value of values || []) {
    const text = normalizeQueryValue(value);
    if (text) unique.set(text.toLocaleLowerCase('en-US'), text.toLocaleLowerCase('en-US'));
  }
  return [...unique.values()].sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function canonicalTrialQuery({ condition, location = null } = {}) {
  const normalizedCondition = normalizeQueryValue(condition)?.toLocaleLowerCase('en-US');
  if (!normalizedCondition) throw AppError.badRequest('condition is required for trial sync');
  const canonicalQuery = Object.freeze({
    condition: normalizedCondition,
    format: 'json',
    location: normalizeQueryValue(location)?.toLocaleLowerCase('en-US') || null,
    overall_status: 'RECRUITING',
    provider: 'clinicaltrials_gov_v2',
  });
  const canonicalJson = JSON.stringify(canonicalQuery);
  return Object.freeze({
    canonicalQuery,
    canonicalJson,
    sourcePartition: `clinicaltrials_gov_v2:${sha256(canonicalJson)}`,
  });
}

/**
 * Pure mapper: one v2 Study to the existing catalog row shape.
 */
export function mapStudyToTrial(study) {
  const protocol = study?.protocolSection || {};
  const id = protocol.identificationModule || {};
  const status = protocol.statusModule || {};
  const description = protocol.descriptionModule || {};
  const eligibility = protocol.eligibilityModule || {};
  const conditions = protocol.conditionsModule || {};
  const contacts = protocol.contactsLocationsModule || {};
  const design = protocol.designModule || {};

  const nctId = id.nctId;
  const title = id.officialTitle || id.briefTitle;
  if (!nctId || !title) return null;

  const overallStatus = String(status.overallStatus || '').toLowerCase();
  const statusMap = {
    recruiting: 'recruiting',
    active_not_recruiting: 'active_not_recruiting',
    enrolling_by_invitation: 'recruiting',
    not_yet_recruiting: 'not_yet_recruiting',
    completed: 'completed',
    terminated: 'terminated',
    withdrawn: 'withdrawn',
    suspended: 'suspended',
  };
  const normalizedStatus = statusMap[overallStatus] || overallStatus || 'unknown';

  const phaseList = Array.isArray(design.phases) ? design.phases : null;
  const phase = phaseList && phaseList.length ? phaseList.join('/') : null;

  function parseAge(value) {
    if (!value) return null;
    const match = /^(\d+)\s*(year|month)s?$/i.exec(String(value).trim());
    if (!match) return null;
    const n = Number(match[1]);
    return /month/i.test(match[2]) ? Math.floor(n / 12) : n;
  }
  const ageMin = parseAge(eligibility.minimumAge);
  const ageMax = parseAge(eligibility.maximumAge);

  const sex = String(eligibility.sex || 'all').toLowerCase();
  const gender = ['male', 'female'].includes(sex) ? sex : 'all';
  const locations = Array.isArray(contacts.locations) ? contacts.locations : [];
  const location = locations[0]?.country || locations[0]?.city || null;
  const conditionList = Array.isArray(conditions.conditions) ? conditions.conditions : [];
  const eligibilitySummary = [
    description.briefSummary ? `Summary: ${description.briefSummary.slice(0, 800)}` : null,
    eligibility.eligibilityCriteria ? `Criteria: ${eligibility.eligibilityCriteria.slice(0, 1500)}` : null,
  ].filter(Boolean).join('\n\n');
  if (!eligibilitySummary) return null;

  return {
    nctId,
    title,
    phase,
    conditions: conditionList,
    eligibilitySummary,
    ageMin,
    ageMax,
    gender,
    location,
    status: normalizedStatus,
    providerRevision: normalizeQueryValue(status.lastUpdatePostDateStruct?.date),
  };
}

async function inferConditionsForTenant(tenantId) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT description, COUNT(*)::int AS frequency
       FROM diagnoses d
       WHERE d.status = 'active'
         AND d.description IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM admissions a
           WHERE a.patient_uid = d.patient_uid
             AND a.tenant_id = $1::uuid
         )
       GROUP BY d.description
       ORDER BY frequency DESC
       LIMIT 10`,
      tenantId,
    );
    const inferred = rows.map(row => row.description).filter(Boolean);
    if (inferred.length) return inferred;
  } catch (err) {
    logger.debug('Condition inference for trial sync failed', { error: err.message });
  }
  return [
    'diabetes mellitus type 2',
    'chronic kidney disease',
    'hypertension',
    'pneumonia',
    'ischemic heart disease',
  ];
}

async function readResponseText(response, errorPrefix) {
  if (!response?.ok) {
    throw new Error(`${errorPrefix}_status_${response?.status ?? 'unknown'}`);
  }
  const raw = await response.text();
  try {
    return { raw, payload: JSON.parse(raw) };
  } catch {
    throw new Error(`${errorPrefix}_invalid_json`);
  }
}

async function fetchProviderRevision(fetchImpl) {
  const response = await fetchImpl(VERSION_URL, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const { payload } = await readResponseText(response, 'clinicaltrials_gov_version');
  const revision = normalizeQueryValue(payload?.dataTimestamp);
  if (!revision) throw new Error('clinicaltrials_gov_version_missing_data_timestamp');
  return Object.freeze({ revision, apiVersion: normalizeQueryValue(payload?.version) });
}

async function fetchStudiesPage({
  condition,
  location,
  pageSize,
  pageToken,
  fetchImpl,
}) {
  const params = new URLSearchParams();
  params.set('format', 'json');
  params.set('pageSize', String(Math.min(Math.max(pageSize, 1), 100)));
  params.set('filter.overallStatus', 'RECRUITING');
  params.set('query.cond', condition);
  if (location) params.set('query.locn', location);
  if (pageToken !== 'origin') params.set('pageToken', pageToken);

  const response = await fetchImpl(`${API_URL}?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const { raw, payload } = await readResponseText(response, 'clinicaltrials_gov');
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.studies)) {
    throw new Error('clinicaltrials_gov_invalid_studies_page');
  }
  return Object.freeze({
    studies: payload.studies,
    nextPageToken: normalizeQueryValue(payload?.nextPageToken),
    rawPayload: raw,
    rawPayloadSha256: sha256(Buffer.from(raw, 'utf8')),
  });
}

async function loadPartitionCursor({ tenantId, sourcePartition }) {
  const rows = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `SELECT id, sync_session_id::text, provider_page_number,
            provider_page_token, provider_next_page_token,
            provider_revision, provider_page_complete, status
       FROM clinical_ai_trial_sync_runs
      WHERE tenant_id = $1::uuid
        AND source_partition = $2::text
      ORDER BY id DESC
      LIMIT 1`,
    tenantId,
    sourcePartition,
  ));
  const latest = rows[0];
  if (!latest || (latest.provider_page_complete && !latest.provider_next_page_token)) {
    return Object.freeze({
      sessionId: randomUUID(),
      pageNumber: 1,
      pageToken: 'origin',
      expectedRevision: null,
    });
  }
  if (!latest.provider_page_complete || latest.status !== 'completed') {
    throw AppError.conflict(
      'ClinicalTrials.gov query partition has unresolved page evidence',
      'I23_TRIAL_QUERY_PARTITION_BLOCKED',
    );
  }
  return Object.freeze({
    sessionId: latest.sync_session_id,
    pageNumber: Number(latest.provider_page_number) + 1,
    pageToken: latest.provider_next_page_token,
    expectedRevision: latest.provider_revision,
  });
}

async function createPageRun({
  tenantId,
  condition,
  location,
  requestedBy,
  sourcePartition,
  canonicalJson,
  sessionId,
  pageNumber,
  pageToken,
  providerRevision,
  pageSize,
  tenantRegion,
}) {
  const rows = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `INSERT INTO clinical_ai_trial_sync_runs
       (tenant_id, source, query_conditions, query_location, requested_by,
        started_at, status, metadata, source_partition, sync_session_id,
        provider_page_number, provider_page_token,
        provider_page_token_sha256, provider_revision,
        provider_page_complete)
     VALUES
       ($1::uuid, 'clinicaltrials_gov_v2', ARRAY[$2::text], $3::text,
        $4::uuid, NOW(), 'running', $5::jsonb, $6::text, $7::uuid,
        $8::integer, $9::text, $10::char(64), $11::text, FALSE)
     RETURNING id`,
    tenantId,
    condition,
    location,
    requestedBy,
    JSON.stringify({
      canonical_query: JSON.parse(canonicalJson),
      page_size: pageSize,
      tenant_region: tenantRegion,
      hwm_evidence: 'provider_page_complete_only',
      status_is_not_hwm: true,
      upsert_coverage_is_not_hwm: true,
    }),
    sourcePartition,
    sessionId,
    pageNumber,
    pageToken,
    sha256(pageToken),
    providerRevision,
  ));
  return rows[0].id;
}

async function failPageRun({
  tenantId,
  runId,
  error,
  providerRevision = null,
  page = null,
}) {
  const message = String(error?.message || error || 'unknown_error').slice(0, 500);
  const nextToken = page?.nextPageToken || null;
  const rows = await setTenantTx(tenantId, tx => tx.$queryRawUnsafe(
    `UPDATE clinical_ai_trial_sync_runs
        SET status = 'failed', finished_at = NOW(), error_message = $3::text,
            provider_revision = COALESCE($4::text, provider_revision),
            provider_next_page_token = $5::text,
            provider_next_page_token_sha256 = $6::char(64),
            provider_page_sha256 = $7::char(64),
            fetched_count = $8::integer,
            upserted_count = 0,
            provider_page_complete = FALSE,
            metadata = metadata || $9::jsonb
      WHERE tenant_id = $1::uuid AND id = $2::integer
        AND status = 'running' AND NOT provider_page_complete
      RETURNING id`,
    tenantId,
    runId,
    message,
    providerRevision,
    nextToken,
    nextToken ? sha256(nextToken) : null,
    page?.rawPayloadSha256 || null,
    page?.studies?.length || 0,
    JSON.stringify({ failure_stage: page ? 'atomic_page_apply' : 'provider_fetch' }),
  ));
  if (rows.length !== 1) {
    throw AppError.conflict('Clinical trial page failure fence was lost', 'I23_PAGE_FAILURE_FENCE_LOST');
  }
  return message;
}

async function applyCompletePage({
  tenantId,
  runId,
  providerRevision,
  page,
}) {
  return setTenantTx(tenantId, async (tx) => {
    let upserted = 0;
    let unmapped = 0;
    let missingRevision = 0;
    for (const study of page.studies) {
      const mapped = mapStudyToTrial(study);
      if (!mapped) {
        unmapped += 1;
        continue;
      }
      if (!mapped.providerRevision) {
        missingRevision += 1;
        continue;
      }
      const result = await upsertTrial({
        tx,
        tenantId,
        nctId: mapped.nctId,
        title: mapped.title,
        phase: mapped.phase,
        conditions: mapped.conditions,
        eligibilitySummary: mapped.eligibilitySummary,
        ageMin: mapped.ageMin,
        ageMax: mapped.ageMax,
        gender: mapped.gender,
        location: mapped.location,
        status: mapped.status,
        providerRevision: mapped.providerRevision,
        sourcePayloadSha256: sha256(JSON.stringify(canonicalize(study))),
        sourceSyncRunId: runId,
      });
      if (!result?.stale_source_revision) upserted += 1;
    }

    const nextToken = page.nextPageToken;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE clinical_ai_trial_sync_runs
          SET status = 'completed', finished_at = NOW(), error_message = NULL,
              provider_revision = $3::text,
              provider_next_page_token = $4::text,
              provider_next_page_token_sha256 = $5::char(64),
              provider_page_sha256 = $6::char(64),
              fetched_count = $7::integer,
              upserted_count = $8::integer,
              provider_page_complete = TRUE,
              metadata = metadata || $9::jsonb
        WHERE tenant_id = $1::uuid AND id = $2::integer
          AND status = 'running' AND NOT provider_page_complete
        RETURNING id`,
      tenantId,
      runId,
      providerRevision,
      nextToken,
      nextToken ? sha256(nextToken) : null,
      page.rawPayloadSha256,
      page.studies.length,
      upserted,
      JSON.stringify({ unmapped_count: unmapped, missing_provider_revision_count: missingRevision }),
    );
    if (rows.length !== 1) {
      throw AppError.conflict('Clinical trial page completion fence was lost', 'I23_PAGE_COMPLETION_FENCE_LOST');
    }
    return Object.freeze({ upserted, unmapped, missingRevision });
  }, { isolationLevel: 'Serializable' });
}

export async function syncTrialsFromPublicRegistry({
  tenantId = null,
  conditions = null,
  location = null,
  maxResults = MAX_RUN_SIZE,
  requestedBy = null,
  tenantRegion = 'IN',
  fetchImpl = globalThis.fetch,
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const inferredConditions = Array.isArray(conditions) && conditions.length > 0
    ? conditions
    : await inferConditionsForTenant(tid);
  const effectiveConditions = normalizeConditions(inferredConditions);
  const effectiveLocation = normalizeQueryValue(
    location != null ? location : (tenantRegion === 'IN' ? 'India' : null),
  );
  const cappedMax = Math.min(
    Math.max(Number.parseInt(maxResults, 10) || MAX_RUN_SIZE, 1),
    MAX_RUN_SIZE,
  );
  if (typeof fetchImpl !== 'function') throw AppError.internal('ClinicalTrials.gov fetch is unavailable');

  let providerVersion = null;
  let providerVersionError = null;
  try {
    providerVersion = await fetchProviderRevision(fetchImpl);
  } catch (err) {
    providerVersionError = err;
  }

  const runIds = [];
  const continuationTokens = [];
  const failures = [];
  let fetchedTotal = 0;
  let upsertedTotal = 0;
  let completedPages = 0;

  for (const condition of effectiveConditions) {
    if (fetchedTotal >= cappedMax) break;
    const query = canonicalTrialQuery({ condition, location: effectiveLocation });
    let cursor;
    try {
      cursor = await loadPartitionCursor({ tenantId: tid, sourcePartition: query.sourcePartition });
    } catch (err) {
      failures.push({ condition, source_partition: query.sourcePartition, error: err.message });
      continue;
    }

    const seenTokens = new Set();
    while (fetchedTotal < cappedMax) {
      const pageSize = Math.min(DEFAULT_PAGE_SIZE, cappedMax - fetchedTotal);
      const runId = await createPageRun({
        tenantId: tid,
        condition,
        location: effectiveLocation,
        requestedBy,
        sourcePartition: query.sourcePartition,
        canonicalJson: query.canonicalJson,
        sessionId: cursor.sessionId,
        pageNumber: cursor.pageNumber,
        pageToken: cursor.pageToken,
        providerRevision: providerVersion?.revision || null,
        pageSize,
        tenantRegion,
      });
      runIds.push(runId);

      if (providerVersionError) {
        const errorMessage = await failPageRun({ tenantId: tid, runId, error: providerVersionError });
        failures.push({ condition, run_id: runId, source_partition: query.sourcePartition, error: errorMessage });
        break;
      }
      if (cursor.expectedRevision && cursor.expectedRevision !== providerVersion.revision) {
        const error = new Error('clinicaltrials_gov_revision_changed_before_continuation');
        const errorMessage = await failPageRun({
          tenantId: tid,
          runId,
          error,
          providerRevision: providerVersion.revision,
        });
        failures.push({ condition, run_id: runId, source_partition: query.sourcePartition, error: errorMessage });
        break;
      }
      if (seenTokens.has(cursor.pageToken)) {
        const error = new Error('clinicaltrials_gov_repeated_page_token');
        const errorMessage = await failPageRun({
          tenantId: tid,
          runId,
          error,
          providerRevision: providerVersion.revision,
        });
        failures.push({ condition, run_id: runId, source_partition: query.sourcePartition, error: errorMessage });
        break;
      }
      seenTokens.add(cursor.pageToken);

      let page;
      try {
        page = await fetchStudiesPage({
          condition,
          location: effectiveLocation,
          pageSize,
          pageToken: cursor.pageToken,
          fetchImpl,
        });
        fetchedTotal += page.studies.length;
        if (page.nextPageToken === cursor.pageToken || seenTokens.has(page.nextPageToken)) {
          throw new Error('clinicaltrials_gov_repeated_page_token');
        }
        const applied = await applyCompletePage({
          tenantId: tid,
          runId,
          providerRevision: providerVersion.revision,
          page,
        });
        upsertedTotal += applied.upserted;
        completedPages += 1;
      } catch (err) {
        const errorMessage = await failPageRun({
          tenantId: tid,
          runId,
          error: err,
          providerRevision: providerVersion.revision,
          page,
        });
        logger.warn('ClinicalTrials.gov page failed', { condition, run_id: runId, error: errorMessage });
        failures.push({ condition, run_id: runId, source_partition: query.sourcePartition, error: errorMessage });
        break;
      }

      if (!page.nextPageToken) break;
      continuationTokens.push({
        source_partition: query.sourcePartition,
        sync_session_id: cursor.sessionId,
        next_page_token: page.nextPageToken,
      });
      cursor = Object.freeze({
        sessionId: cursor.sessionId,
        pageNumber: cursor.pageNumber + 1,
        pageToken: page.nextPageToken,
        expectedRevision: providerVersion.revision,
      });
    }
  }

  const errorMessage = failures.length
    ? failures.map(item => `${item.condition}:${item.error}`).join('; ').slice(0, 500)
    : null;
  return Object.freeze({
    run_id: runIds[0] || null,
    run_ids: Object.freeze(runIds),
    tenant_id: tid,
    status: failures.length ? 'failed' : 'completed',
    source: 'clinicaltrials_gov_v2',
    provider_revision: providerVersion?.revision || null,
    query_conditions: Object.freeze(effectiveConditions),
    query_location: effectiveLocation,
    fetched_count: fetchedTotal,
    upserted_count: upsertedTotal,
    completed_pages: completedPages,
    failed_pages: failures.length,
    continuation_tokens: Object.freeze(continuationTokens),
    failures: Object.freeze(failures),
    error_message: errorMessage,
  });
}

export async function listTrialSyncRuns({ tenantId = null, limit = 20 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
  try {
    const rows = await setTenantTx(tid, tx => tx.$queryRawUnsafe(
      `SELECT id, source, query_conditions, query_location, status,
              fetched_count, upserted_count, started_at, finished_at,
              error_message, metadata, source_partition,
              sync_session_id::text, provider_page_number,
              provider_page_token, provider_next_page_token,
              provider_revision, provider_page_sha256::text,
              provider_page_complete, recovery_inbox_id::text,
              effect_disposition
       FROM clinical_ai_trial_sync_runs
       WHERE tenant_id = $1::uuid
       ORDER BY started_at DESC, id DESC
       LIMIT $2`,
      tid,
      safeLimit,
    ));
    return { runs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { runs: [], count: 0 };
    throw err;
  }
}

export default {
  canonicalTrialQuery,
  listTrialSyncRuns,
  mapStudyToTrial,
  syncTrialsFromPublicRegistry,
};
