import crypto from 'node:crypto';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { AppError } from '../../utils/AppError.js';
import { createLabThresholdExceptionReviewTaskTx } from '../workflow/taskService.js';

const ACTIVE_TASK_STATUSES = ['open', 'in_progress', 'blocked', 'overdue'];
const EXCEPTION_ROLE = 'LAB_INCHARGE';
const MAX_NOTIFICATION_RECIPIENTS = 500;
const EXCEPTION_COLUMNS = `id, tenant_id, facility_id, result_id, patient_uid,
  test_code, loinc_code, specimen_type, unit, unmatched_reason, severity,
  lifecycle_status, assigned_role, assigned_to_uid, task_id, first_seen_at,
  last_seen_at, occurrence_count, reconciliation_attempts, last_reconciled_at,
  resolved_by, resolved_at, resolution_reason, resolved_bundle_id,
  resolved_rule_id, resolved_catalog_entry_id, metadata`;
const RESULT_THRESHOLD_COLUMNS = `id, tenant_id, booking_id, investigation_id,
  admission_id, patient_uid, patient_name, loinc_code, test_code, test_name,
  value_text, value_numeric, unit, reference_range, reference_range_low,
  reference_range_high, abnormal_flag, status, is_critical, criticality_status,
  facility_id, specimen_type, threshold_policy_bundle_id,
  threshold_policy_rule_id, threshold_catalog_entry_id, threshold_evaluated_at,
  performed_by_lab, performed_at, received_at, signed_off_at, signed_off_by,
  comments, created_at, updated_at`;

function governedReferencePresentation(assessment) {
  if (!assessment.matched || assessment.evaluationMode !== 'numeric_threshold') {
    return { text: null, low: null, high: null, abnormalFlag: null };
  }
  const low = assessment.referenceLow == null ? null : Number(assessment.referenceLow);
  const high = assessment.referenceHigh == null ? null : Number(assessment.referenceHigh);
  const value = assessment.evaluatedValue == null ? null : Number(assessment.evaluatedValue);
  const unit = assessment.thresholdUnit || '';
  let text = null;
  if (low != null && high != null) text = `${low}–${high} ${unit}`.trim();
  else if (low != null) text = `>= ${low} ${unit}`.trim();
  else if (high != null) text = `<= ${high} ${unit}`.trim();
  let abnormalFlag = null;
  if (assessment.breachedSide === 'low') abnormalFlag = 'LL';
  else if (assessment.breachedSide === 'high') abnormalFlag = 'HH';
  else if (value != null && low != null && value < low) abnormalFlag = 'L';
  else if (value != null && high != null && value > high) abnormalFlag = 'H';
  else if (low != null || high != null) abnormalFlag = 'N';
  return { text, low, high, abnormalFlag };
}

async function auditTx(tx, {
  tenantId,
  actorUid = null,
  actorRole = 'SYSTEM',
  action,
  resourceId,
  metadata,
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, actor_uid, role, action, resource, resource_id,
        metadata, created_at)
     VALUES ($1::uuid, $2::uuid, $2::uuid, $3, $4,
             'lab_threshold_unmatched_exceptions', $5, $6::jsonb, NOW())`,
    tenantId,
    actorUid,
    actorRole,
    action,
    String(resourceId),
    JSON.stringify(metadata || {}),
  );
}

async function activeExceptionTaskTx(tx, { tenantId, exceptionId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id, status, assigned_to_uid, assigned_to_role
       FROM tasks
      WHERE tenant_id = $1::uuid
        AND related_resource_type = 'lab_threshold_exception'
        AND related_resource_id = $2::uuid::text
        AND status = ANY($3::text[])
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    exceptionId,
    ACTIVE_TASK_STATUSES,
  );
  return rows[0] || null;
}

async function ensureExceptionTaskTx(tx, {
  tenantId,
  exceptionId,
  result,
  assessment,
  assignedToUid,
  assignedRole,
  source,
}) {
  const existing = await activeExceptionTaskTx(tx, { tenantId, exceptionId });
  if (existing) return existing;
  const created = await createLabThresholdExceptionReviewTaskTx({
    tenantId,
    exceptionId,
    resultId: result.id,
    patientUid: result.patient_uid,
    testName: result.test_name,
    unmatchedReason: assessment.unmatchedReason,
    source,
    assignedToUid,
    assignedToRole: assignedToUid ? null : assignedRole,
    tx,
  });
  if (created) return created;
  const raced = await activeExceptionTaskTx(tx, { tenantId, exceptionId });
  if (!raced) {
    throw AppError.internal(
      'Lab threshold exception review task could not be materialized',
      'LAB_THRESHOLD_EXCEPTION_TASK_MISSING',
    );
  }
  return raced;
}

async function queueExceptionNotificationsTx(tx, {
  tenantId,
  exceptionId,
  taskId,
  result,
  assessment,
  assignedToUid,
  assignedRole,
  source,
}) {
  const recipients = await tx.$queryRawUnsafe(
    `SELECT id, uid
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active = TRUE
        AND LOWER(COALESCE(status, '')) = 'active'
        AND is_deleted IS FALSE
        AND deleted_at IS NULL
        AND role <> 'PATIENT'
        AND (
          ($2::uuid IS NOT NULL AND uid = $2::uuid)
          OR ($2::uuid IS NULL AND role = $3)
        )
      ORDER BY id
      LIMIT $4::int`,
    tenantId,
    assignedToUid,
    assignedRole,
    MAX_NOTIFICATION_RECIPIENTS + 1,
  );
  if (recipients.length > MAX_NOTIFICATION_RECIPIENTS) {
    throw AppError.internal(
      'Lab threshold exception notification audience exceeds its safety bound',
      'LAB_THRESHOLD_EXCEPTION_AUDIENCE_EXCEEDED',
    );
  }
  for (const recipient of recipients) {
    await notificationOutbox.queue({
      tenantId,
      type: 'lab_threshold_exception',
      channel: 'inapp',
      recipientId: recipient.id,
      title: 'Laboratory policy exception requires review',
      body: `${result.test_name} could not be classified by the active governed laboratory policy (${assessment.unmatchedReason}).`,
      sourceEventKey: `lab-threshold-exception:${exceptionId}`,
      templateVersion: 'lab_threshold_policy_exception.v1',
      data: {
        kind: 'lab_threshold_policy_exception',
        exception_id: exceptionId,
        task_id: Number(taskId),
        lab_result_id: Number(result.id),
        test_code: result.test_code,
        unmatched_reason: assessment.unmatchedReason,
        source,
      },
    }, { tx, strict: true });
  }
  return recipients.length;
}

export async function materializeLabThresholdExceptionTx({
  tx,
  tenantId,
  result,
  assessment,
  source,
  reconciliationAttempt = false,
}) {
  if (assessment?.matched !== false || !assessment?.unmatchedReason) {
    throw AppError.internal(
      'Unmatched lab threshold assessment is required',
      'LAB_THRESHOLD_UNMATCHED_ASSESSMENT_REQUIRED',
    );
  }
  const existingRows = await tx.$queryRawUnsafe(
    `SELECT id, lifecycle_status, assigned_role, assigned_to_uid, task_id
       FROM lab_threshold_unmatched_exceptions
      WHERE tenant_id = $1::uuid
        AND result_id = $2::int
        AND patient_uid = $3::uuid
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    Number(result.id),
    result.patient_uid,
  );
  const existing = existingRows[0] || null;
  const exceptionId = existing?.id || crypto.randomUUID();
  const assignedToUid = existing?.assigned_to_uid || null;
  const assignedRole = existing?.assigned_role || EXCEPTION_ROLE;
  const task = await ensureExceptionTaskTx(tx, {
    tenantId,
    exceptionId,
    result,
    assessment,
    assignedToUid,
    assignedRole,
    source,
  });
  const metadata = {
    source,
    policy_bundle_id: assessment.policyBundleId || null,
    catalog_entry_id: assessment.catalogEntryId || null,
    catalog_revision: assessment.catalogRevision || null,
    evaluated_at: assessment.evaluatedAt,
    evaluation_details: assessment.details || {},
  };
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO lab_threshold_unmatched_exceptions
       (id, tenant_id, facility_id, result_id, patient_uid, test_code,
        loinc_code, specimen_type, unit, unmatched_reason, severity,
        lifecycle_status, assigned_role, assigned_to_uid, task_id,
        first_seen_at, last_seen_at, occurrence_count,
        reconciliation_attempts, last_reconciled_at,
        resolved_by, resolved_at, resolution_reason,
        resolved_bundle_id, resolved_rule_id, resolved_catalog_entry_id,
        metadata)
     VALUES ($1::uuid, $2::uuid, $3::int, $4::int, $5::uuid, $6,
             $7, $8, $9, $10, 'high', 'open', $11, $12::uuid, $13::int,
             NOW(), NOW(), 1,
             CASE WHEN $15::boolean THEN 1 ELSE 0 END,
             CASE WHEN $15::boolean THEN NOW() ELSE NULL END,
             NULL, NULL, NULL, NULL, NULL, NULL, $14::jsonb)
     ON CONFLICT (tenant_id, result_id) DO UPDATE
       SET facility_id = EXCLUDED.facility_id,
           patient_uid = EXCLUDED.patient_uid,
           test_code = EXCLUDED.test_code,
           loinc_code = EXCLUDED.loinc_code,
           specimen_type = EXCLUDED.specimen_type,
           unit = EXCLUDED.unit,
           unmatched_reason = EXCLUDED.unmatched_reason,
           severity = EXCLUDED.severity,
           lifecycle_status = 'open',
           assigned_role = EXCLUDED.assigned_role,
           assigned_to_uid = EXCLUDED.assigned_to_uid,
           task_id = EXCLUDED.task_id,
           last_seen_at = NOW(),
           occurrence_count = lab_threshold_unmatched_exceptions.occurrence_count
             + CASE WHEN $15::boolean THEN 0 ELSE 1 END,
           reconciliation_attempts = lab_threshold_unmatched_exceptions.reconciliation_attempts
             + CASE WHEN $15::boolean THEN 1 ELSE 0 END,
           last_reconciled_at = CASE
             WHEN $15::boolean THEN NOW()
             ELSE lab_threshold_unmatched_exceptions.last_reconciled_at
           END,
           resolved_by = NULL,
           resolved_at = NULL,
           resolution_reason = NULL,
           resolved_bundle_id = NULL,
           resolved_rule_id = NULL,
           resolved_catalog_entry_id = NULL,
           metadata = EXCLUDED.metadata
     RETURNING ${EXCEPTION_COLUMNS}`,
    exceptionId,
    tenantId,
    assessment.facilityId,
    Number(result.id),
    result.patient_uid,
    result.test_code,
    result.loinc_code || null,
    assessment.specimenType || result.specimen_type || null,
    result.unit || null,
    assessment.unmatchedReason,
    assignedRole,
    assignedToUid,
    Number(task.id),
    JSON.stringify(metadata),
    reconciliationAttempt === true,
  );
  let exception = rows[0];
  if (!exception) {
    throw AppError.internal(
      'Lab threshold exception could not be persisted',
      'LAB_THRESHOLD_EXCEPTION_PERSIST_FAILED',
    );
  }
  const notificationRecipientCount = await queueExceptionNotificationsTx(tx, {
    tenantId,
    exceptionId: exception.id,
    taskId: task.id,
    result,
    assessment,
    assignedToUid,
    assignedRole,
    source,
  });
  const evidenced = await tx.$queryRawUnsafe(
    `UPDATE lab_threshold_unmatched_exceptions
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
      RETURNING ${EXCEPTION_COLUMNS}`,
    tenantId,
    exception.id,
    JSON.stringify({ notification_recipient_count: notificationRecipientCount }),
  );
  exception = evidenced[0] || exception;
  await auditTx(tx, {
    tenantId,
    action: reconciliationAttempt
      ? 'LAB_THRESHOLD_EXCEPTION_RECONCILIATION_DEFERRED'
      : (existing ? 'LAB_THRESHOLD_EXCEPTION_REOBSERVED' : 'LAB_THRESHOLD_EXCEPTION_OPENED'),
    resourceId: exception.id,
    metadata: {
      result_id: Number(result.id),
      unmatched_reason: assessment.unmatchedReason,
      task_id: Number(task.id),
      notification_recipient_count: notificationRecipientCount,
      source,
    },
  });
  return { exception, task };
}

export async function resolveLabThresholdExceptionTx({
  tx,
  tenantId,
  result,
  assessment,
  source,
  resolvedBy = null,
  resolvedByRole = 'SYSTEM',
  resolutionReason = 'matched_governed_policy',
}) {
  if (assessment?.matched !== true || !assessment?.policyBundleId || !assessment?.catalogEntryId) {
    throw AppError.internal(
      'Matched governed lab threshold assessment is required',
      'LAB_THRESHOLD_MATCHED_ASSESSMENT_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `SELECT ${EXCEPTION_COLUMNS}
       FROM lab_threshold_unmatched_exceptions
      WHERE tenant_id = $1::uuid
        AND result_id = $2::int
        AND patient_uid = $3::uuid
      LIMIT 1
      FOR UPDATE`,
    tenantId,
    Number(result.id),
    result.patient_uid,
  );
  const exception = rows[0] || null;
  if (!exception || exception.lifecycle_status === 'resolved') return exception;
  const completedTasks = await tx.$queryRawUnsafe(
    `UPDATE tasks
        SET status = 'completed',
            completed_at = COALESCE(completed_at, NOW()),
            metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND related_resource_type = 'lab_threshold_exception'
        AND related_resource_id = $3::uuid::text
        AND status = ANY($5::text[])
      RETURNING id`,
    tenantId,
    Number(exception.task_id),
    exception.id,
    JSON.stringify({
      resolved_by_policy_bundle_id: assessment.policyBundleId,
      resolved_by_policy_rule_id: assessment.policyRuleId || null,
      resolved_by_catalog_entry_id: assessment.catalogEntryId,
      resolution_source: source,
    }),
    ACTIVE_TASK_STATUSES,
  );
  if (!completedTasks[0]) {
    throw AppError.internal(
      'Lab threshold exception task could not be completed',
      'LAB_THRESHOLD_EXCEPTION_TASK_COMPLETION_FAILED',
    );
  }
  const resolved = await tx.$queryRawUnsafe(
    `UPDATE lab_threshold_unmatched_exceptions
        SET lifecycle_status = 'resolved',
            last_reconciled_at = NOW(),
            reconciliation_attempts = reconciliation_attempts + 1,
            resolved_by = $4::uuid,
            resolved_at = NOW(),
            resolution_reason = $5,
            resolved_bundle_id = $6::uuid,
            resolved_rule_id = $7::uuid,
            resolved_catalog_entry_id = $8::uuid,
            metadata = COALESCE(metadata, '{}'::jsonb) || $9::jsonb
      WHERE tenant_id = $1::uuid
        AND id = $2::uuid
        AND result_id = $3::int
        AND lifecycle_status = 'open'
      RETURNING ${EXCEPTION_COLUMNS}`,
    tenantId,
    exception.id,
    Number(result.id),
    resolvedBy,
    resolutionReason,
    assessment.policyBundleId,
    assessment.policyRuleId || null,
    assessment.catalogEntryId,
    JSON.stringify({ resolution_source: source }),
  );
  if (!resolved[0]) {
    throw AppError.conflict(
      'Lab threshold exception changed during resolution',
      'LAB_THRESHOLD_EXCEPTION_CHANGED',
    );
  }
  await auditTx(tx, {
    tenantId,
    actorUid: resolvedBy,
    actorRole: resolvedByRole,
    action: 'LAB_THRESHOLD_EXCEPTION_RESOLVED',
    resourceId: exception.id,
    metadata: {
      result_id: Number(result.id),
      policy_bundle_id: assessment.policyBundleId,
      policy_rule_id: assessment.policyRuleId || null,
      catalog_entry_id: assessment.catalogEntryId,
      resolution_reason: resolutionReason,
      source,
    },
  });
  return resolved[0];
}

export async function applyLabThresholdAssessmentTx({
  tx,
  tenantId,
  result,
  assessment,
  source,
  reconciliationAttempt = false,
  resolvedBy = null,
  resolvedByRole = 'SYSTEM',
  resolutionReason = 'matched_governed_policy',
}) {
  const status = assessment?.criticalityStatus;
  if (![
    'within_policy',
    'critical',
    'not_applicable',
    'threshold_unavailable',
  ].includes(status)) {
    throw AppError.internal(
      'Lab threshold assessment status is invalid',
      'LAB_THRESHOLD_ASSESSMENT_STATUS_INVALID',
    );
  }
  const reference = governedReferencePresentation(assessment);
  const updated = await tx.$queryRawUnsafe(
    `UPDATE lab_results
        SET facility_id = COALESCE($4::int, facility_id),
            specimen_type = COALESCE(specimen_type, $5),
            criticality_status = $6,
            threshold_policy_bundle_id = $7::uuid,
            threshold_policy_rule_id = $8::uuid,
            threshold_catalog_entry_id = $9::uuid,
            threshold_evaluated_at = $10::timestamptz,
            is_critical = $11::boolean,
            reference_range = $12,
            reference_range_low = $13::numeric,
            reference_range_high = $14::numeric,
            abnormal_flag = $15,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid
        AND id = $2::int
        AND patient_uid = $3::uuid
      RETURNING ${RESULT_THRESHOLD_COLUMNS}`,
    tenantId,
    Number(result.id),
    result.patient_uid,
    assessment.facilityId || null,
    assessment.specimenType || null,
    status,
    assessment.policyBundleId || null,
    assessment.policyRuleId || null,
    assessment.catalogEntryId || null,
    assessment.evaluatedAt || new Date(),
    assessment.breached === true,
    reference.text,
    reference.low,
    reference.high,
    reference.abnormalFlag,
  );
  if (!updated[0]) {
    throw AppError.internal(
      'Lab result threshold policy evidence could not be persisted',
      'LAB_THRESHOLD_RESULT_EVIDENCE_PERSIST_FAILED',
    );
  }

  if (assessment.matched) {
    const exception = await resolveLabThresholdExceptionTx({
      tx,
      tenantId,
      result: updated[0],
      assessment,
      source,
      resolvedBy,
      resolvedByRole,
      resolutionReason,
    });
    return { result: updated[0], exception, task: null };
  }
  const materialized = await materializeLabThresholdExceptionTx({
    tx,
    tenantId,
    result: updated[0],
    assessment,
    source,
    reconciliationAttempt,
  });
  return { result: updated[0], ...materialized };
}

export default {
  applyLabThresholdAssessmentTx,
  materializeLabThresholdExceptionTx,
  resolveLabThresholdExceptionTx,
};
