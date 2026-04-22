/**
 * ClinicalTrials.gov v2 sync.
 *
 * Pulls recruiting trials matching tenant-specific conditions + locations
 * and upserts them into clinical_ai_trials_catalog. Public API, no auth
 * needed. Every run persists to clinical_ai_trial_sync_runs for audit.
 *
 * Design:
 *   - API call is bounded (max 100 trials per run) and timeout-safe.
 *   - Conditions default to the tenant's most-common active diagnoses so
 *     the catalog stays clinically relevant.
 *   - Mapping is pure and unit-testable (see mapStudyToTrial).
 *   - Sync never throws on a single malformed row — it logs and continues.
 */

import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';
import { upsertTrial } from './trialMatcherService.js';

const API_URL = 'https://clinicaltrials.gov/api/v2/studies';
const DEFAULT_PAGE_SIZE = 50;
const MAX_RUN_SIZE = 200;
const REQUEST_TIMEOUT_MS = 20_000;

function resolveTenantId(options = {}) {
  return options.tenantId || DEFAULT_TENANT_ID;
}

function isMissingSchemaError(err) {
  return /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

/**
 * Pure mapper: one v2 Study → our clinical_ai_trials_catalog row shape.
 * Returns null if the study lacks the minimum fields we require.
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

  // Eligibility age fields are free text like "18 Years"; parse to ints.
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
  };
}

/**
 * Pull the 10 most common active diagnosis descriptions for this tenant.
 * Used as a default query seed when the caller doesn't pass explicit
 * conditions. Falls back to a short generic list if the tenant has no
 * data yet.
 */
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
      tenantId
    );
    const inferred = rows.map((row) => row.description).filter(Boolean);
    if (inferred.length) return inferred;
  } catch (err) {
    logger.debug('Condition inference for trial sync failed', { error: err.message });
  }
  // Sensible India-first defaults when there's no data yet.
  return [
    'diabetes mellitus type 2',
    'chronic kidney disease',
    'hypertension',
    'pneumonia',
    'ischemic heart disease',
  ];
}

async function fetchStudies({ condition, location, pageSize = DEFAULT_PAGE_SIZE }) {
  const params = new URLSearchParams();
  params.set('format', 'json');
  params.set('pageSize', String(Math.min(Math.max(pageSize, 1), 100)));
  params.set('filter.overallStatus', 'RECRUITING');
  if (condition) params.set('query.cond', condition);
  if (location) params.set('query.locn', location);

  const response = await fetch(`${API_URL}?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`clinicaltrials_gov_status_${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload?.studies) ? payload.studies : [];
}

/**
 * Sync recruiting trials for the given tenant. `conditions` defaults to
 * the tenant's most-common active diagnoses. `location` defaults to
 * India for DPDP tenants; override at call time for other regions.
 */
export async function syncTrialsFromPublicRegistry({
  tenantId = null,
  conditions = null,
  location = null,
  maxResults = MAX_RUN_SIZE,
  requestedBy = null,
  tenantRegion = 'IN',
} = {}) {
  const tid = resolveTenantId({ tenantId });
  const effectiveConditions = Array.isArray(conditions) && conditions.length > 0
    ? conditions
    : await inferConditionsForTenant(tid);
  const effectiveLocation = location != null ? location : (tenantRegion === 'IN' ? 'India' : null);
  const cappedMax = Math.min(Math.max(Number.parseInt(maxResults, 10) || MAX_RUN_SIZE, 1), MAX_RUN_SIZE);

  // Insert the run row immediately so a crash still leaves an audit trail.
  let runId = null;
  try {
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO clinical_ai_trial_sync_runs
         (tenant_id, source, query_conditions, query_location, requested_by, started_at, status, metadata)
       VALUES ($1::uuid, 'clinicaltrials_gov_v2', $2, $3, $4::uuid, NOW(), 'running', $5::jsonb)
       RETURNING id`,
      tid,
      effectiveConditions,
      effectiveLocation,
      requestedBy,
      JSON.stringify({ max_results: cappedMax, tenant_region: tenantRegion })
    );
    runId = rows[0]?.id || null;
  } catch (err) {
    if (!isMissingSchemaError(err)) {
      logger.warn('Trial sync run-row insert failed', { error: err.message });
    }
  }

  let fetchedTotal = 0;
  let upsertedTotal = 0;
  let errorMessage = null;

  try {
    for (const condition of effectiveConditions) {
      if (fetchedTotal >= cappedMax) break;
      const pageSize = Math.min(DEFAULT_PAGE_SIZE, cappedMax - fetchedTotal);
      let studies;
      try {
        studies = await fetchStudies({ condition, location: effectiveLocation, pageSize });
      } catch (err) {
        logger.warn('clinicaltrials.gov fetch failed', { condition, error: err.message });
        continue;
      }
      fetchedTotal += studies.length;
      for (const study of studies) {
        const mapped = mapStudyToTrial(study);
        if (!mapped) continue;
        try {
          await upsertTrial({
            tenantId: tid,
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
          });
          upsertedTotal += 1;
        } catch (err) {
          logger.debug('Trial upsert skipped', { nctId: mapped.nctId, error: err.message });
        }
      }
    }
  } catch (err) {
    errorMessage = String(err?.message || 'unknown_error').slice(0, 500);
    logger.error('Trial sync run failed', { error: errorMessage });
  }

  const finalStatus = errorMessage ? 'failed' : 'completed';
  try {
    if (runId) {
      await prisma.$queryRawUnsafe(
        `UPDATE clinical_ai_trial_sync_runs
         SET status = $2,
             fetched_count = $3,
             upserted_count = $4,
             finished_at = NOW(),
             error_message = $5
         WHERE id = $1`,
        runId,
        finalStatus,
        fetchedTotal,
        upsertedTotal,
        errorMessage
      );
    }
  } catch (err) {
    logger.warn('Trial sync finalize failed', { runId, error: err.message });
  }

  return {
    run_id: runId,
    tenant_id: tid,
    status: finalStatus,
    source: 'clinicaltrials_gov_v2',
    query_conditions: effectiveConditions,
    query_location: effectiveLocation,
    fetched_count: fetchedTotal,
    upserted_count: upsertedTotal,
    error_message: errorMessage,
  };
}

export async function listTrialSyncRuns({ tenantId = null, limit = 20 } = {}) {
  const tid = resolveTenantId({ tenantId });
  const safeLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 20, 1), 100);
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, source, query_conditions, query_location, status, fetched_count,
              upserted_count, started_at, finished_at, error_message, metadata
       FROM clinical_ai_trial_sync_runs
       WHERE tenant_id = $1::uuid
       ORDER BY started_at DESC
       LIMIT $2`,
      tid,
      safeLimit
    );
    return { runs: rows, count: rows.length };
  } catch (err) {
    if (isMissingSchemaError(err)) return { runs: [], count: 0 };
    throw err;
  }
}

export default {
  listTrialSyncRuns,
  mapStudyToTrial,
  syncTrialsFromPublicRegistry,
};
