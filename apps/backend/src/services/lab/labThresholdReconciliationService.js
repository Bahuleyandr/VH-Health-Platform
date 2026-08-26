import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { resolveCurrentHumanActorTx } from '../workflow/workflowHumanOwnerService.js';
import { materializeLabCriticalAlertGeneration } from './labCriticalAlertService.js';
import { evaluateCriticalThreshold } from './labCriticalThresholdService.js';
import { applyLabThresholdAssessmentTx } from './labThresholdExceptionService.js';
import { notifyCreatedCriticalLabAlerts } from './labResultsService.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXCEPTION_STATUSES = new Set(['open', 'resolved']);
const UNMATCHED_REASONS = new Set([
  'facility_unresolved',
  'no_catalog',
  'no_active_bundle',
  'catalog_revision_mismatch',
  'policy_not_effective',
  'no_matching_rule',
  'ambiguous_policy',
  'unit_mismatch',
  'specimen_mismatch',
  'demographic_mismatch',
  'non_numeric_value',
]);
const MANUAL_RECONCILIATION_ROLES = new Set(['ADMIN', 'SUPER_ADMIN', 'LAB_INCHARGE']);

function positiveInteger(value, label, { max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw AppError.badRequest(`${label} must be a positive integer no greater than ${max}`);
  }
  return parsed;
}

function uuid(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw AppError.badRequest(`${label} must be a UUID`);
  return normalized;
}

function optionalStatus(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!EXCEPTION_STATUSES.has(normalized)) {
    throw AppError.badRequest('lifecycle_status must be open or resolved');
  }
  return normalized;
}

function optionalReason(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!UNMATCHED_REASONS.has(normalized)) {
    throw AppError.badRequest('unmatched_reason is invalid');
  }
  return normalized;
}

const EXCEPTION_SELECT = `SELECT exception_row.id, exception_row.tenant_id,
       exception_row.facility_id, exception_row.result_id,
       exception_row.patient_uid, exception_row.test_code,
       exception_row.loinc_code, exception_row.specimen_type,
       exception_row.unit, exception_row.unmatched_reason,
       exception_row.severity, exception_row.lifecycle_status,
       exception_row.assigned_role, exception_row.assigned_to_uid,
       exception_row.task_id, exception_row.first_seen_at,
       exception_row.last_seen_at, exception_row.occurrence_count,
       exception_row.reconciliation_attempts,
       exception_row.last_reconciled_at, exception_row.resolved_by,
       exception_row.resolved_at, exception_row.resolution_reason,
       exception_row.resolved_bundle_id, exception_row.resolved_rule_id,
       exception_row.resolved_catalog_entry_id, exception_row.metadata,
       result.test_name AS result_test_name,
       result.value_text AS result_value_text,
       result.value_numeric AS result_value_numeric,
       result.status AS result_status,
       result.criticality_status AS result_criticality_status,
       task.status AS task_status,
       task.priority AS task_priority,
       task.assigned_to_uid AS task_assigned_to_uid,
       task.assigned_to_role AS task_assigned_to_role
  FROM lab_threshold_unmatched_exceptions AS exception_row
  JOIN lab_results AS result
    ON result.tenant_id = exception_row.tenant_id
   AND result.id = exception_row.result_id
   AND result.patient_uid = exception_row.patient_uid
  JOIN tasks AS task
    ON task.tenant_id = exception_row.tenant_id
   AND task.id = exception_row.task_id
   AND task.related_resource_type = 'lab_threshold_exception'
   AND task.related_resource_id = exception_row.id::text`;

export async function listLabThresholdExceptions({
  tenantId,
  lifecycleStatus = 'open',
  facilityId = null,
  unmatchedReason = null,
  limit = 100,
} = {}) {
  const tid = requireTenantId(tenantId);
  const status = optionalStatus(lifecycleStatus);
  const facility = facilityId == null || facilityId === ''
    ? null
    : positiveInteger(facilityId, 'facility_id', { max: 2147483647 });
  const reason = optionalReason(unmatchedReason);
  const rowLimit = positiveInteger(limit, 'limit', { max: 500 });
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `${EXCEPTION_SELECT}
       WHERE exception_row.tenant_id = $1::uuid
         AND ($2::text IS NULL OR exception_row.lifecycle_status = $2::text)
         AND ($3::int IS NULL OR exception_row.facility_id = $3::int)
         AND ($4::text IS NULL OR exception_row.unmatched_reason = $4::text)
       ORDER BY
         CASE WHEN exception_row.lifecycle_status = 'open' THEN 0 ELSE 1 END,
         exception_row.last_reconciled_at NULLS FIRST,
         exception_row.first_seen_at,
         exception_row.id
       LIMIT $5::int`,
      tid,
      status,
      facility,
      reason,
      rowLimit,
    );
    return { exceptions: rows, count: rows.length };
  });
}

export async function getLabThresholdException({ tenantId, exceptionId } = {}) {
  const tid = requireTenantId(tenantId);
  const id = uuid(exceptionId, 'exception_id');
  return setTenantTx(tid, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `${EXCEPTION_SELECT}
       WHERE exception_row.tenant_id = $1::uuid
         AND exception_row.id = $2::uuid
       LIMIT 1`,
      tid,
      id,
    );
    if (!rows[0]) throw AppError.notFound('Lab threshold exception not found');
    return rows[0];
  });
}

async function lockedExceptionResultTx(tx, { tenantId, exceptionId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT exception_row.id AS exception_id,
            exception_row.lifecycle_status AS exception_lifecycle_status,
            exception_row.reconciliation_attempts,
            result.id, result.tenant_id, result.booking_id,
            result.investigation_id, result.admission_id, result.patient_uid,
            result.patient_name, result.loinc_code, result.test_code,
            result.test_name, result.value_text, result.value_numeric,
            result.unit, result.reference_range, result.reference_range_low,
            result.reference_range_high, result.abnormal_flag, result.status,
            result.is_critical, result.criticality_status, result.facility_id,
            result.specimen_type, result.threshold_policy_bundle_id,
            result.threshold_policy_rule_id, result.threshold_catalog_entry_id,
            result.threshold_evaluated_at, result.performed_by_lab,
            result.performed_at, result.received_at, result.signed_off_at,
            result.signed_off_by, result.comments, result.created_at,
            result.updated_at
       FROM lab_threshold_unmatched_exceptions AS exception_row
       JOIN lab_results AS result
         ON result.tenant_id = exception_row.tenant_id
        AND result.id = exception_row.result_id
        AND result.patient_uid = exception_row.patient_uid
      WHERE exception_row.tenant_id = $1::uuid
        AND exception_row.id = $2::uuid
      LIMIT 1
      FOR UPDATE OF exception_row, result`,
    tenantId,
    exceptionId,
  );
  return rows[0] || null;
}

export async function reconcileLabThresholdExceptionTx({
  tx,
  tenantId,
  exceptionId,
  source = 'lab_threshold_exception_reconciliation',
  actorUid = null,
  actorRole = 'SYSTEM',
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = uuid(exceptionId, 'exception_id');
  if (!tx?.$queryRawUnsafe || !tx?.$executeRawUnsafe) {
    throw AppError.internal(
      'Lab threshold exception reconciliation requires a tenant transaction',
      'LAB_THRESHOLD_RECONCILIATION_TX_REQUIRED',
    );
  }
  let currentActor = null;
  if (actorUid != null) {
    currentActor = await resolveCurrentHumanActorTx({
      tx,
      tenantId: tid,
      actorUid,
      authenticatedRoles: [actorRole],
      authenticatedPrimaryRole: actorRole,
      authenticatedRawRole: actorRole,
      rolePredicate: role => MANUAL_RECONCILIATION_ROLES.has(role),
    });
  }
  const result = await lockedExceptionResultTx(tx, { tenantId: tid, exceptionId: id });
  if (!result) throw AppError.notFound('Lab threshold exception not found');
  if (result.exception_lifecycle_status === 'resolved') {
    return {
      exception_id: id,
      result_id: Number(result.id),
      outcome: 'already_resolved',
      assessment: null,
      materialization: null,
      result,
    };
  }

  const assessment = await evaluateCriticalThreshold({ client: tx, tenantId: tid, result });
  const applied = await applyLabThresholdAssessmentTx({
    tx,
    tenantId: tid,
    result,
    assessment,
    source,
    reconciliationAttempt: assessment.matched !== true,
    resolvedBy: currentActor?.uid || null,
    resolvedByRole: currentActor?.rawRole || 'SYSTEM',
    resolutionReason: currentActor
      ? 'manual_governed_policy_reconciliation'
      : 'scheduled_governed_policy_reconciliation',
  });
  let materialization = null;
  if (assessment.breached === true) {
    materialization = await materializeLabCriticalAlertGeneration({
      tx,
      tenantId: tid,
      resultId: Number(result.id),
      expectedPatientUid: result.patient_uid,
      criticality: assessment,
      source,
    });
  }
  return {
    exception_id: id,
    result_id: Number(result.id),
    outcome: assessment.matched ? 'resolved' : 'deferred',
    assessment,
    materialization,
    result: applied.result,
  };
}

export async function reconcileLabThresholdException({
  tenantId,
  exceptionId,
  source = 'lab_threshold_exception_reconciliation',
  actorUid = null,
  actorRole = 'SYSTEM',
} = {}) {
  const tid = requireTenantId(tenantId);
  const id = uuid(exceptionId, 'exception_id');
  const outcome = await setTenantTx(tid, (tx) => reconcileLabThresholdExceptionTx({
    tx,
    tenantId: tid,
    exceptionId: id,
    source,
    actorUid,
    actorRole,
  }));

  if (outcome.materialization?.created === true) {
    await notifyCreatedCriticalLabAlerts({
      tenantId: tid,
      materializations: [{ ...outcome.materialization, result: outcome.result }],
    });
  }
  return outcome;
}

export async function reconcileLabThresholdExceptionsForTenant({
  tenantId,
  limit = 100,
} = {}) {
  const tid = requireTenantId(tenantId);
  const rowLimit = positiveInteger(limit, 'limit', { max: 500 });
  const candidateIds = await setTenantTx(tid, async (tx) => tx.$queryRawUnsafe(
    `SELECT id
       FROM lab_threshold_unmatched_exceptions
      WHERE tenant_id = $1::uuid
        AND lifecycle_status = 'open'
      ORDER BY last_reconciled_at NULLS FIRST, first_seen_at, id
      LIMIT $2::int`,
    tid,
    rowLimit,
  ));
  const counters = {
    observed: candidateIds.length,
    resolved: 0,
    deferred: 0,
    already_resolved: 0,
    critical_alerts_created: 0,
    failures: 0,
  };
  const failures = [];
  for (const candidate of candidateIds) {
    try {
      const outcome = await reconcileLabThresholdException({
        tenantId: tid,
        exceptionId: candidate.id,
        source: 'lab_threshold_exception_scheduled_reconciliation',
      });
      counters[outcome.outcome] += 1;
      if (outcome.materialization?.created === true) counters.critical_alerts_created += 1;
    } catch (error) {
      counters.failures += 1;
      failures.push(error);
    }
  }
  if (failures.length) {
    const aggregate = new AggregateError(
      failures,
      `Lab threshold reconciliation failed for ${failures.length} of ${candidateIds.length} exceptions`,
    );
    aggregate.code = 'LAB_THRESHOLD_RECONCILIATION_PARTIAL_FAILURE';
    aggregate.result = counters;
    throw aggregate;
  }
  return counters;
}

export default {
  getLabThresholdException,
  listLabThresholdExceptions,
  reconcileLabThresholdException,
  reconcileLabThresholdExceptionTx,
  reconcileLabThresholdExceptionsForTenant,
};
