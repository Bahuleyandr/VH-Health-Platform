import crypto from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { normalizeSecurityAuditRow } from './siemExportService.js';

export const I25_PARITY_GATES = Object.freeze([
  'stable fenced cutoff',
  'shape parity',
  'capture completeness (recomputed payload SHA-256 per row)',
  'per-target delivery completeness from attempt lineage (never export_status)',
  'real acknowledgement policy',
  'cursor equality only where gate 4 passes, else pause at the greatest proven contiguous point with a reconciliation reason',
  'non-destructive fenced cutover (old cursor/events/attempts remain queryable; migrate the existing SIEM cursor only after parity; never delete old evidence)',
  'single writer after cutover (legacy writer frozen, canonical offsets authoritative; never both)',
  'crash/restart injection proofs at every boundary',
  'negative migration proof (any mismatch aborts with zero partial canonical rows)',
]);

export const I25_CUTOVER_CRASH_BOUNDARIES = Object.freeze([
  'after_stable_fenced_cutoff',
  'after_shape_parity',
  'after_capture_completeness',
  'after_per_target_delivery_completeness',
  'after_real_acknowledgement_policy',
  'after_cursor_plan',
  'after_non_destructive_evidence_check',
  'after_single_writer_offsets',
  'after_legacy_writer_freeze',
  'before_commit',
]);

function fail(message, code, details = undefined) {
  throw AppError.conflict(message, code, details);
}

function requireText(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw AppError.badRequest(`${label} is invalid`);
  return text;
}

function requirePositiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw AppError.badRequest(`${label} must be a positive safe integer`);
  }
  return parsed;
}

function maybeCrash(boundary, requested) {
  if (boundary === requested) {
    throw new Error(`I25_CRASH_INJECTION:${boundary}`);
  }
}

function severityAtLeast(severity, minimum) {
  const rank = { high: 2, critical: 3 };
  return (rank[severity] || 0) >= (rank[minimum] || 0);
}

function sourceIdNumber(value) {
  if (!/^\d+$/.test(String(value || ''))) {
    fail('I25 captured event has non-numeric audit_log source identity', 'I25_SHAPE_PARITY_FAILED');
  }
  return requirePositiveInteger(value, 'audit_log source id');
}

function targetPartition(targetId) {
  return `siem:audit_log:security:target:${targetId}`;
}

function computeTargetDeliveryPlan({ target, events, attempts, cutoff }) {
  const eligible = events
    .filter(event => severityAtLeast(event.severity, target.min_severity))
    .sort((left, right) => sourceIdNumber(left.source_id) - sourceIdNumber(right.source_id));
  const byEvent = new Map();
  for (const attempt of attempts.filter(row => String(row.target_id) === String(target.id))) {
    const list = byEvent.get(String(attempt.event_id)) || [];
    list.push(attempt);
    byEvent.set(String(attempt.event_id), list);
  }

  let greatestProven = 0;
  let firstUnproven = null;
  for (const event of eligible) {
    const eventAttempts = byEvent.get(String(event.id)) || [];
    const positive = eventAttempts.some(attempt => (
      attempt.acknowledgement_state === 'positive'
      && attempt.status === 'succeeded'
      && attempt.payload_sha256 === event.payload_sha256
    ));
    if (!positive) {
      firstUnproven = sourceIdNumber(event.source_id);
      break;
    }
    greatestProven = sourceIdNumber(event.source_id);
  }

  const complete = firstUnproven === null;
  return Object.freeze({
    targetId: String(target.id),
    targetKey: target.target_key,
    sourcePartition: targetPartition(target.id),
    complete,
    highWaterPosition: complete ? cutoff : greatestProven,
    highWaterToken: complete
      ? `audit_log:${cutoff}:target:${target.id}:positive_ack`
      : `audit_log:${greatestProven}:target:${target.id}:positive_ack`,
    reconciliationReason: complete
      ? 'activation_not_authorized'
      : `per_target_delivery_unproven_at_${firstUnproven}`,
    eligibleEvents: eligible.length,
    firstUnproven,
  });
}

function validateAcknowledgementPolicy(target) {
  const contract = target.acknowledgement_contract;
  if (!contract || contract === 'unclassified') {
    fail(
      `I25 target ${target.target_key} has no owner-classified acknowledgement contract`,
      'I25_ACKNOWLEDGEMENT_POLICY_UNCLASSIFIED',
    );
  }
  if (!target.acknowledgement_classified_by
      || !target.acknowledgement_owner_reason
      || !target.acknowledgement_owner_evidence
      || typeof target.acknowledgement_owner_evidence !== 'object') {
    fail(
      `I25 target ${target.target_key} lacks owner acknowledgement evidence`,
      'I25_ACKNOWLEDGEMENT_POLICY_UNCLASSIFIED',
    );
  }
}

export async function performSiemCanonicalCutover({
  tenantId = null,
  expectedCutoffSourceId,
  generation = 1,
  policyVersion,
  policySignature,
  retentionPolicy,
  retentionUntil,
  crashAt = null,
} = {}) {
  const tid = requireTenantId(tenantId);
  const cutoff = requirePositiveInteger(expectedCutoffSourceId, 'expected_cutoff_source_id');
  const safeGeneration = requirePositiveInteger(generation, 'generation');
  const policy = Object.freeze({
    version: requireText(policyVersion, 'policy_version', 80),
    signature: requireText(policySignature, 'policy_signature', 128),
    retention: requireText(retentionPolicy, 'retention_policy', 80),
    until: new Date(retentionUntil),
  });
  if (Number.isNaN(policy.until.getTime())) throw AppError.badRequest('retention_until is invalid');
  if (crashAt && !I25_CUTOVER_CRASH_BOUNDARIES.includes(crashAt)) {
    throw AppError.badRequest('crash_at is not a registered I25 boundary');
  }

  return setTenantTx(tid, async (tx) => {
    const cursors = await tx.$queryRawUnsafe(
      `SELECT id, last_source_id::text, last_source_ref, last_source_at,
              last_captured_at, writer_state, canonical_capture_offset_id::text,
              capture_schedule_decision
         FROM siem_export_cursors
        WHERE tenant_id = $1::uuid
          AND source_name = 'audit_log'
          AND cursor_key = 'security'
        FOR UPDATE`,
      tid,
    );
    const cursor = cursors[0];
    if (!cursor || cursor.writer_state !== 'legacy_capture'
        || Number(cursor.last_source_id) !== cutoff) {
      fail('I25 stable legacy capture cutoff fence does not match', 'I25_STABLE_CUTOFF_FAILED');
    }
    maybeCrash('after_stable_fenced_cutoff', crashAt);

    const auditRows = await tx.$queryRawUnsafe(
      `SELECT id, uid, tenant_id, action, resource, resource_id, metadata,
              ip_address, created_at, user_id, user_name, user_role, method,
              path, module, status_code, success, user_agent, actor_uid,
              subject_uid, request_summary
         FROM audit_log
        WHERE tenant_id = $1::uuid
          AND module = 'security'
          AND id <= $2::bigint
        ORDER BY id ASC
        FOR SHARE`,
      tid,
      cutoff,
    );
    const events = await tx.$queryRawUnsafe(
      `SELECT id, source_id, source_created_at, event_type, severity,
              minimized_payload, payload_sha256::text, export_status
         FROM siem_export_events
        WHERE tenant_id = $1::uuid
          AND source_name = 'audit_log'
          AND source_id ~ '^[0-9]+$'
          AND source_id::bigint <= $2::bigint
        ORDER BY source_id::bigint ASC
        FOR SHARE`,
      tid,
      cutoff,
    );
    const auditIds = auditRows.map(row => String(row.id));
    const eventIds = events.map(row => String(row.source_id));
    if (auditIds.length !== eventIds.length
        || auditIds.some((id, index) => id !== eventIds[index])) {
      fail('I25 audit/event shape parity failed', 'I25_SHAPE_PARITY_FAILED', {
        audit_rows: auditIds.length,
        event_rows: eventIds.length,
      });
    }
    maybeCrash('after_shape_parity', crashAt);

    for (let index = 0; index < auditRows.length; index += 1) {
      const normalized = normalizeSecurityAuditRow(auditRows[index], tid);
      if (events[index].payload_sha256 !== normalized.payload_sha256) {
        fail('I25 captured payload SHA-256 completeness failed', 'I25_CAPTURE_COMPLETENESS_FAILED', {
          source_id: String(auditRows[index].id),
        });
      }
    }
    maybeCrash('after_capture_completeness', crashAt);

    const targets = await tx.$queryRawUnsafe(
      `SELECT id, target_key, transport, status, min_severity,
              acknowledgement_contract, acknowledgement_config,
              acknowledgement_classified_by::text,
              acknowledgement_owner_reason, acknowledgement_owner_evidence
         FROM siem_export_targets
        WHERE tenant_id = $1::uuid AND status = 'active'
        ORDER BY id ASC
        FOR SHARE`,
      tid,
    );
    if (targets.length === 0) {
      fail('I25 cutover requires at least one active owner-classified target', 'I25_NO_ACTIVE_TARGETS');
    }
    const attempts = await tx.$queryRawUnsafe(
      `SELECT d.id, d.event_id, d.target_id, d.attempt_number, d.status,
              d.payload_sha256::text, d.acknowledgement_state,
              d.acknowledgement_evidence, d.acknowledged_at,
              e.source_id, e.export_status
         FROM siem_export_delivery_attempts d
         JOIN siem_export_events e
           ON e.tenant_id = d.tenant_id AND e.id = d.event_id
        WHERE d.tenant_id = $1::uuid
          AND e.source_name = 'audit_log'
          AND e.source_id ~ '^[0-9]+$'
          AND e.source_id::bigint <= $2::bigint
        ORDER BY d.target_id, e.source_id::bigint, d.attempt_number
        FOR SHARE`,
      tid,
      cutoff,
    );
    const plans = targets.map(target => computeTargetDeliveryPlan({
      target,
      events,
      attempts,
      cutoff,
    }));
    maybeCrash('after_per_target_delivery_completeness', crashAt);

    targets.forEach(validateAcknowledgementPolicy);
    maybeCrash('after_real_acknowledgement_policy', crashAt);
    maybeCrash('after_cursor_plan', crashAt);

    const beforeCounts = await tx.$queryRawUnsafe(
      `SELECT
         (SELECT COUNT(*)::integer FROM siem_export_cursors WHERE tenant_id = $1::uuid) AS cursors,
         (SELECT COUNT(*)::integer FROM siem_export_events WHERE tenant_id = $1::uuid) AS events,
         (SELECT COUNT(*)::integer FROM siem_export_delivery_attempts WHERE tenant_id = $1::uuid) AS attempts`,
      tid,
    );
    maybeCrash('after_non_destructive_evidence_check', crashAt);

    const fenceToken = crypto.randomUUID();
    const captureOffsets = await tx.$queryRawUnsafe(
      `INSERT INTO event_consumer_offsets
         (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
          direction, source_partition, consumer_key, generation, cursor_kind,
          high_water_position, high_water_token, retained_from_position,
          retained_from_token, recovery_state, reconciliation_reason,
          policy_version, policy_signature, retention_policy, retention_until,
          historical_cutoff_event_id, backfill_cursor_event_id)
       VALUES
         ('external_interface', $1::uuid, 'tenant', NULL, 'I25', 'outbound',
          'siem:audit_log:security:capture', 'external:I25', $2::integer,
          'capture_into_event_ledger', $3::bigint, $4::text, 0,
          'audit_log:0:captured', 'paused', 'capture_scheduler_activation_not_authorized',
          $5::text, $6::text, $7::text, $8::timestamptz, NULL, NULL)
       RETURNING offset_id::text`,
      tid,
      safeGeneration,
      cutoff,
      `audit_log:${cutoff}:captured`,
      policy.version,
      policy.signature,
      policy.retention,
      policy.until,
    );
    const captureOffsetId = captureOffsets[0].offset_id;

    const deliveryOffsets = [];
    for (const plan of plans) {
      const rows = await tx.$queryRawUnsafe(
        `INSERT INTO event_consumer_offsets
           (scope_kind, tenant_id, facility_scope, facility_id, interface_family,
            direction, source_partition, consumer_key, generation, cursor_kind,
            high_water_position, high_water_token, retained_from_position,
            retained_from_token, recovery_state, reconciliation_reason,
            policy_version, policy_signature, retention_policy, retention_until,
            historical_cutoff_event_id, backfill_cursor_event_id)
         VALUES
           ('external_interface', $1::uuid, 'tenant', NULL, 'I25', 'outbound',
            $2::text, 'external:I25', $3::integer, 'per_target_positive_ack',
            $4::bigint, $5::text, 0, 'audit_log:0:positive_ack',
            'paused', $6::text, $7::text, $8::text, $9::text,
            $10::timestamptz, NULL, NULL)
         RETURNING offset_id::text`,
        tid,
        plan.sourcePartition,
        safeGeneration,
        plan.highWaterPosition,
        plan.highWaterToken,
        plan.reconciliationReason,
        policy.version,
        policy.signature,
        policy.retention,
        policy.until,
      );
      deliveryOffsets.push(Object.freeze({ ...plan, offsetId: rows[0].offset_id }));
    }
    maybeCrash('after_single_writer_offsets', crashAt);

    const evidence = {
      contract: 'vhhealth.i25.siem-canonical-cutover/v1',
      fence_token: fenceToken,
      cutoff_source_id: cutoff,
      parity_gates: I25_PARITY_GATES,
      capture_rows: auditRows.length,
      target_plans: deliveryOffsets.map(plan => ({
        target_id: plan.targetId,
        target_key: plan.targetKey,
        complete: plan.complete,
        high_water_position: plan.highWaterPosition,
        first_unproven: plan.firstUnproven,
      })),
      prior_counts: beforeCounts[0],
      capture_schedule_decision: cursor.capture_schedule_decision,
      activation_performed: false,
    };
    const frozen = await tx.$queryRawUnsafe(
      `UPDATE siem_export_cursors
          SET writer_state = 'canonical_offsets',
              canonical_capture_offset_id = $3::uuid,
              cutover_fence_token = $4::uuid,
              cutover_at = NOW(),
              cutover_evidence = $5::jsonb,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::bigint
          AND writer_state = 'legacy_capture'
          AND last_source_id = $6::bigint
        RETURNING id, writer_state, canonical_capture_offset_id::text,
                  cutover_fence_token::text, cutover_at`,
      tid,
      String(cursor.id),
      captureOffsetId,
      fenceToken,
      JSON.stringify(evidence),
      cutoff,
    );
    if (frozen.length !== 1) {
      fail('I25 single-writer freeze fence was lost', 'I25_SINGLE_WRITER_FENCE_LOST');
    }
    maybeCrash('after_legacy_writer_freeze', crashAt);
    maybeCrash('before_commit', crashAt);

    return Object.freeze({
      tenant_id: tid,
      legacy_cursor_id: String(cursor.id),
      cutoff_source_id: cutoff,
      fence_token: fenceToken,
      capture_offset_id: captureOffsetId,
      delivery_offsets: Object.freeze(deliveryOffsets),
      writer_state: 'canonical_offsets',
      recovery_state: 'paused',
      capture_schedule_decision: cursor.capture_schedule_decision,
      activation_performed: false,
      parity_gates: I25_PARITY_GATES,
    });
  }, { isolationLevel: 'Serializable' });
}

export default Object.freeze({
  I25_CUTOVER_CRASH_BOUNDARIES,
  I25_PARITY_GATES,
  performSiemCanonicalCutover,
});
