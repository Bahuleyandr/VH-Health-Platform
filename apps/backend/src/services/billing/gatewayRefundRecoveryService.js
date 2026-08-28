import prisma, { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { decryptField } from '../../utils/fieldEncryption.js';
import { toPaise } from '../../utils/money.js';
import { notificationOutbox } from '../../utils/notifications/notificationOutbox.js';
import { requireTenantId } from '../tenant/tenantService.js';
import {
  applyGatewayRefundProviderEvidence,
  isExactProviderIdentifier,
  resolveGatewayContext,
} from './paymentGatewayService.js';
import { resolveAdapter } from './gatewayProviders/index.js';
import { sha256Hex } from './gatewayProviders/webhookSignature.js';

const RECOVERY_RULE_CODE = 'payment_gateway_refund_recovery';
const RECOVERY_ROLES = Object.freeze([
  'FINANCE_INCHARGE', 'BILLING_INCHARGE', 'ADMIN', 'SUPER_ADMIN',
]);
const RECOVERY_LEASE_MINUTES = 5;
const RECOVERY_MAX_ATTEMPTS = 8;
const DEFAULT_BATCH_LIMIT = 25;

export const PAYMENT_GATEWAY_REFUND_RECOVERY_DISABLED =
  'PAYMENT_GATEWAY_REFUND_RECOVERY_DISABLED';

export function isGatewayRefundRecoveryEnabled(env = process.env) {
  return String(env.PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED || '').toLowerCase() === 'true';
}

export function gatewayRefundRecoveryBackoffMinutes(attemptCount) {
  const attempt = Math.max(1, Number.parseInt(attemptCount, 10) || 1);
  return Math.min(60, 2 ** Math.min(attempt - 1, 6));
}

function requireRecoveryActivation() {
  if (!isGatewayRefundRecoveryEnabled()) {
    throw AppError.forbidden(
      'Automatic payment gateway refund recovery is not activated',
      PAYMENT_GATEWAY_REFUND_RECOVERY_DISABLED,
      { activation_gate: 'PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED=true' },
    );
  }
}

function positiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw AppError.badRequest(`${field} must be a positive integer`);
  }
  return parsed;
}

function safeLimit(value) {
  return Math.max(1, Math.min(Number.parseInt(value, 10) || DEFAULT_BATCH_LIMIT, 100));
}

function refundReceipt(row) {
  const identity = JSON.stringify([
    String(row.tenant_id),
    String(row.patient_uid || ''),
    'payment_gateway_refund',
    `billing_refund:${Number(row.billing_refund_id)}`,
    `gateway_order:${Number(row.gateway_order_id)}`,
    String(row.provider_idempotency_key),
  ]);
  return `pgr-${sha256Hex(identity).slice(0, 32)}`;
}

function recoveryView(row) {
  if (!row) return null;
  const {
    provider_idempotency_key: _providerKey,
    provider_request_replay_authorized: _providerRequestReplayAuthorized,
    recovery_claim_token: _claimToken,
    recovery_claimed_at: _claimedAt,
    recovery_lease_expires_at: _leaseExpiresAt,
    key_id: _providerKeyId,
    key_secret_ciphertext: _providerKeySecret,
    provider_config_id: _providerConfigId,
    provider_config_enabled: _providerConfigEnabled,
    config_provider: _configProvider,
    config_environment: _configEnvironment,
    billing_approved_by: _billingApprovedBy,
    billing_approved_at: _billingApprovedAt,
    stored_initiator_tenant_valid: _storedInitiatorTenantValid,
    request_fingerprint_valid: _requestFingerprintValid,
    patient_uid: _patientUid,
    metadata: _internalMetadata,
    ...safe
  } = row;
  return {
    ...safe,
    id: Number(row.id),
    gateway_order_id: Number(row.gateway_order_id),
    billing_refund_id: row.billing_refund_id == null ? null : Number(row.billing_refund_id),
    amount: Number(row.amount),
    recovery_attempt_count: Number(row.recovery_attempt_count || 0),
    recovery_task_id: row.recovery_task_id == null ? null : Number(row.recovery_task_id),
  };
}

async function queueFinanceRecoveryNotificationTx(tx, {
  tenantId, row, outcome, eventKey = null,
}) {
  const transitionKey = eventKey || outcome;
  const recipients = await tx.$queryRawUnsafe(
    `SELECT id, phone, role
       FROM users
      WHERE tenant_id = $1::uuid
        AND is_active = true
        AND role = ANY($2::text[])
      ORDER BY role, id`,
    tenantId,
    RECOVERY_ROLES,
  );
  let queued = 0;
  for (const recipient of recipients) {
    const outbox = await notificationOutbox.queue({
      tenantId,
      type: 'push',
      recipientId: recipient.id,
      recipientPhone: recipient.phone || null,
      title: outcome === 'opened'
        ? 'Gateway refund awaiting provider confirmation'
        : (outcome === 'operator_resolved'
          ? 'Gateway refund reconciliation resolved by operator'
          : `Gateway refund recovery: ${outcome}`),
      body: outcome === 'opened'
        ? 'A finance task is open until the provider confirms the refund status.'
        : (outcome === 'operator_resolved'
          ? `Gateway refund ${row.id} was manually reconciled; it was not projected as provider success.`
          : `Gateway refund ${row.id} reached recovery outcome ${outcome}.`),
      sourceEventKey: `gateway-refund-recovery:${row.id}:${transitionKey}`,
      data: {
        kind: 'payment_gateway_refund_recovery',
        gateway_refund_id: Number(row.id),
        billing_refund_id: row.billing_refund_id == null
          ? null
          : Number(row.billing_refund_id),
        recovery_state: outcome,
        task_id: row.recovery_task_id == null ? null : Number(row.recovery_task_id),
        provider_request_fingerprint: row.provider_request_fingerprint,
      },
    }, { tx, strict: true });
    if (outbox) queued += 1;
  }
  if (!queued) {
    const outbox = await notificationOutbox.queue({
      tenantId,
      type: 'inapp',
      title: 'Gateway refund recovery requires finance action',
      body: `Gateway refund ${row.id} reached recovery outcome ${outcome}.`,
      sourceEventKey: `gateway-refund-recovery:${row.id}:${transitionKey}:finance-role`,
      data: {
        kind: 'payment_gateway_refund_recovery',
        gateway_refund_id: Number(row.id),
        billing_refund_id: row.billing_refund_id == null
          ? null
          : Number(row.billing_refund_id),
        recovery_state: outcome,
        task_id: row.recovery_task_id == null ? null : Number(row.recovery_task_id),
        provider_request_fingerprint: row.provider_request_fingerprint,
        target_roles: RECOVERY_ROLES,
      },
    }, { tx, strict: true });
    if (outbox) queued += 1;
  }
  return queued;
}

async function insertRecoveryAuditTx(tx, {
  tenantId, row, action, actorUid = null, metadata = {}, dedupeKey,
}) {
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_logs
       (tenant_id, uid, actor_uid, role, action, resource, resource_id, metadata, created_at)
     SELECT $1::uuid, $2::uuid, $2::uuid,
            CASE WHEN $2::uuid IS NULL THEN 'system' ELSE 'operator' END,
            $3, 'payment_gateway_refund', $4::text, $5::jsonb, NOW()
      WHERE NOT EXISTS (
        SELECT 1
          FROM audit_logs
         WHERE tenant_id = $1::uuid
           AND action = $3
           AND resource = 'payment_gateway_refund'
           AND resource_id = $4::text
           AND metadata->>'recovery_event_key' = $6::text
      )`,
    tenantId,
    actorUid ? String(actorUid) : null,
    action,
    String(row.id),
    JSON.stringify({
      recovery_event_key: dedupeKey,
      gateway_refund_id: Number(row.id),
      billing_refund_id: row.billing_refund_id == null ? null : Number(row.billing_refund_id),
      provider: row.provider,
      environment: row.environment,
      provider_request_fingerprint: row.provider_request_fingerprint,
      ...metadata,
    }),
    dedupeKey,
  );
}

export async function ensureGatewayRefundRecoveryObligationTx({
  tx, tenantId, gatewayRefundId, parkFailure = null, claimToken = null,
}) {
  const tenant = requireTenantId(tenantId);
  const id = positiveInt(gatewayRefundId, 'gatewayRefundId');
  if (!tx) throw new TypeError('ensureGatewayRefundRecoveryObligationTx requires tx');
    const refundRows = await tx.$queryRawUnsafe(
      `SELECT refund.*, orders.patient_uid::text
         FROM payment_gateway_refunds refund
         JOIN payment_gateway_orders orders
           ON orders.id = refund.gateway_order_id
          AND orders.tenant_id = refund.tenant_id
        WHERE refund.tenant_id = $1::uuid
          AND refund.id = $2::int
        FOR UPDATE OF refund`,
      tenant,
      id,
    );
    let refund = refundRows[0];
    if (!refund) throw AppError.notFound('Payment gateway refund not found');
    if (claimToken && String(refund.recovery_claim_token || '') !== String(claimToken)) {
      return { row: refund, created: false, lostFence: true };
    }
    if (parkFailure) {
      const parkedRows = await tx.$queryRawUnsafe(
        `UPDATE payment_gateway_refunds
            SET provider_refund_id = COALESCE(provider_refund_id, $3::varchar),
                 status = CASE WHEN $8::boolean THEN status ELSE 'requires_reconciliation' END,
                 failure_code = $4::varchar,
                 failure_reason = $5::text,
                 metadata = CASE
                   WHEN reconciliation_disposition IS NULL THEN metadata
                   ELSE jsonb_set(
                     COALESCE(metadata, '{}'::jsonb),
                     '{provider_evidence_superseded_reconciliations}',
                     (
                       CASE
                         WHEN jsonb_typeof(metadata->'provider_evidence_superseded_reconciliations') = 'array'
                           THEN metadata->'provider_evidence_superseded_reconciliations'
                         ELSE '[]'::jsonb
                       END
                     ) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                       'reconciled_at', reconciled_at,
                       'reconciled_by', reconciled_by,
                       'disposition', reconciliation_disposition,
                       'evidence', reconciliation_evidence,
                       'reviewed_by', reconciliation_reviewed_by,
                       'reviewed_at', reconciliation_reviewed_at,
                       'superseded_by', $4::text
                     ))),
                     true
                   )
                 END,
                 reconciled_at = NULL,
                 reconciliation_note = NULL,
                 reconciled_by = NULL,
                 reconciliation_disposition = NULL,
                 reconciliation_evidence = NULL,
                 reconciliation_reviewed_by = NULL,
                 reconciliation_reviewed_at = NULL,
                 recovery_state = CASE WHEN $8::boolean THEN 'retry_wait' ELSE 'requires_reconciliation' END,
                 recovery_next_attempt_at = CASE WHEN $8::boolean THEN NOW() ELSE NULL END,
                 recovery_terminal_at = CASE WHEN $8::boolean THEN NULL ELSE NOW() END,
                 recovery_last_error_code = $4::varchar,
                 recovery_last_error_reason = $5::text,
                 recovery_claim_token = NULL,
                 recovery_claimed_at = NULL,
                 recovery_lease_expires_at = NULL,
                 updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int
             AND status IN ('initiated', 'pending', 'processed', 'failed', 'requires_reconciliation')
             AND ($7::uuid IS NULL OR (
               recovery_claim_token = $7::uuid AND recovery_state = 'claimed'
             ))
          RETURNING *, $6::text AS patient_uid`,
        tenant,
        id,
        parkFailure.providerRefundId || null,
        String(parkFailure.code || 'provider_recovery_failed').slice(0, 80),
        String(parkFailure.reason || 'Gateway refund recovery requires operator review').slice(0, 500),
        refund.patient_uid || null,
        claimToken ? String(claimToken) : null,
        parkFailure.preserveProviderStatus === true,
      );
      if (!parkedRows.length && claimToken) {
        return { row: refund, created: false, lostFence: true };
      }
      refund = parkedRows[0] || refund;
    }
    if (!parkFailure
        && (['processed', 'failed'].includes(refund.status) || refund.reconciled_at)) {
      return { row: refund, created: false };
    }

    const slaRows = await tx.$queryRawUnsafe(
      `WITH selected_rule AS (
         SELECT id, rule_code, target_minutes, severity,
                owner_role_codes, escalation_role_codes
           FROM workflow_sla_rules
          WHERE enabled = TRUE
            AND rule_code = $3
            AND (tenant_id = $1::uuid OR tenant_id IS NULL)
          ORDER BY CASE WHEN tenant_id = $1::uuid THEN 0 ELSE 1 END
          LIMIT 1
       ), inserted AS (
         INSERT INTO workflow_sla_instances
           (tenant_id, rule_id, rule_code, patient_uid, source_table, source_id,
            status, priority, started_at, due_at, assigned_role_codes, metadata)
         SELECT $1::uuid, rule.id, rule.rule_code, $4::uuid,
                'payment_gateway_refunds', $2::text,
                'active', rule.severity, NOW(),
                NOW() + make_interval(mins => rule.target_minutes),
                rule.owner_role_codes,
                jsonb_build_object(
                  'gateway_refund_id', $2::int,
                  'billing_refund_id', $5::int,
                  'escalation_role_codes', rule.escalation_role_codes,
                  'completion_authority', 'provider_status_evidence'
                )
           FROM selected_rule rule
         ON CONFLICT (tenant_id, rule_code, source_table, source_id)
         WHERE source_table IS NOT NULL AND source_id IS NOT NULL
         DO NOTHING
         RETURNING *, TRUE AS inserted
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT existing.*, FALSE AS inserted
         FROM workflow_sla_instances existing
        WHERE existing.tenant_id = $1::uuid
          AND existing.rule_code = $3
          AND existing.source_table = 'payment_gateway_refunds'
          AND existing.source_id = $2::text
          AND NOT EXISTS (SELECT 1 FROM inserted)
       LIMIT 1`,
      tenant,
      id,
      RECOVERY_RULE_CODE,
      refund.patient_uid || null,
      refund.billing_refund_id == null ? null : Number(refund.billing_refund_id),
    );
    let sla = slaRows[0];
    let rearmed = false;
    if (!sla) {
      throw new AppError(
        'Gateway refund recovery SLA rule is unavailable',
        503,
        'PAYMENT_GATEWAY_REFUND_RECOVERY_SLA_UNAVAILABLE',
      );
    }
    if (sla.completed_at || ['completed', 'cancelled'].includes(sla.status)) {
      const reopenedRows = await tx.$queryRawUnsafe(
        `UPDATE workflow_sla_instances sla
            SET status = 'active',
                started_at = NOW(),
                due_at = NOW() + make_interval(mins => rule.target_minutes),
                completed_at = NULL,
                breached_at = NULL,
                escalated_at = NULL,
                metadata = (
                  sla.metadata - ARRAY[
                    'completed_via', 'completed_by_task', 'completion_evidence',
                    'provider_outcome'
                  ]
                ) || jsonb_build_object(
                  'reopen_history',
                  (
                    CASE
                      WHEN jsonb_typeof(sla.metadata->'reopen_history') = 'array'
                        THEN sla.metadata->'reopen_history'
                      ELSE '[]'::jsonb
                    END
                  ) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                    'prior_status', sla.status,
                    'prior_completed_at', sla.completed_at,
                    'prior_completion_evidence', sla.metadata->'completion_evidence',
                    'reopened_at', NOW(),
                    'reason', 'provider_refund_reconciliation_reopened'
                  )))
                ),
                updated_at = NOW()
           FROM workflow_sla_rules rule
          WHERE sla.tenant_id = $1::uuid
            AND sla.id = $2::uuid
            AND rule.id = sla.rule_id
          RETURNING sla.*`,
        tenant,
        String(sla.id),
      );
      sla = reopenedRows[0];
      if (!sla) {
        throw new AppError(
          'Gateway refund recovery SLA could not be rearmed',
          503,
          'PAYMENT_GATEWAY_REFUND_RECOVERY_SLA_REARM_FAILED',
        );
      }
      rearmed = true;
    }

    const taskRows = await tx.$queryRawUnsafe(
       `WITH inserted AS (
          INSERT INTO tasks
            (tenant_id, task_kind, title, description, patient_uid,
             related_resource_type, related_resource_id, priority, status,
             assigned_to_role, due_at, workflow_sla_instance_id,
             sla_completion_semantics, metadata)
          SELECT
            $1::uuid, 'review',
            'Confirm payment gateway refund with provider',
            'Provider confirmation is required before this refund can be treated as paid.',
            $3::uuid, 'payment_gateway_refunds', $2::text, 'high', 'open',
           'FINANCE_INCHARGE', $4::timestamptz, $6::uuid,
           'domain_evidence',
           jsonb_build_object(
             'gateway_refund_id', $2::int,
             'billing_refund_id', $5::int,
             'gateway_refund_recovery_sla_id', $6::uuid,
             'sla_instance_id', $6::uuid::text,
             'sla_key', $11::text,
             'owner_role_codes', $7::text[],
             'task_contract', 'payment_gateway_refund_recovery_v1',
             'provider', $8::text,
              'environment', $9::text,
              'provider_request_fingerprint', $10::text
            )
           WHERE $12::int IS NULL
          ON CONFLICT (tenant_id, related_resource_type, related_resource_id)
         WHERE status IN ('open', 'in_progress', 'blocked', 'overdue')
           AND related_resource_type IS NOT NULL
           AND related_resource_id IS NOT NULL
         DO NOTHING
         RETURNING *, TRUE AS inserted
       )
       SELECT * FROM inserted
       UNION ALL
       SELECT existing.*, FALSE AS inserted
         FROM tasks existing
         WHERE existing.tenant_id = $1::uuid
           AND existing.related_resource_type = 'payment_gateway_refunds'
           AND existing.related_resource_id = $2::text
           AND (
             ($12::int IS NOT NULL AND existing.id = $12::int)
             OR (
               $12::int IS NULL
               AND existing.status IN ('open', 'in_progress', 'blocked', 'overdue')
             )
           )
           AND NOT EXISTS (SELECT 1 FROM inserted)
       ORDER BY id DESC
       LIMIT 1`,
      tenant,
      id,
      refund.patient_uid || null,
      sla.due_at,
      refund.billing_refund_id == null ? null : Number(refund.billing_refund_id),
      sla.id,
      RECOVERY_ROLES,
      refund.provider,
      refund.environment,
      refund.provider_request_fingerprint,
      RECOVERY_RULE_CODE,
      refund.recovery_task_id == null ? null : Number(refund.recovery_task_id),
    );
    const task = taskRows[0];
    if (!task) {
      throw new AppError(
        'Gateway refund recovery task could not be created',
        503,
        'PAYMENT_GATEWAY_REFUND_RECOVERY_TASK_UNAVAILABLE',
      );
    }
    const boundTaskRows = await tx.$queryRawUnsafe(
       `UPDATE tasks
          SET workflow_sla_instance_id = $3::uuid,
              sla_completion_semantics = 'domain_evidence',
              status = 'open',
              completed_at = NULL,
              due_at = $4::timestamptz,
              metadata = CASE
                WHEN completed_at IS NULL THEN metadata
                ELSE metadata || jsonb_build_object(
                  'reopen_history',
                  (
                    CASE
                      WHEN jsonb_typeof(metadata->'reopen_history') = 'array'
                        THEN metadata->'reopen_history'
                      ELSE '[]'::jsonb
                    END
                  ) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                    'prior_status', status,
                    'prior_completed_at', completed_at,
                    'reopened_at', NOW(),
                    'reason', 'provider_refund_reconciliation_reopened'
                  )))
                )
              END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
          AND (
            workflow_sla_instance_id IS NULL
            OR workflow_sla_instance_id = $3::uuid
          )
        RETURNING id, workflow_sla_instance_id, sla_completion_semantics`,
      tenant,
      Number(task.id),
       String(sla.id),
      sla.due_at,
    );
    if (boundTaskRows.length !== 1) {
      throw new AppError(
        'Gateway refund recovery task is bound to a different SLA',
        409,
        'PAYMENT_GATEWAY_REFUND_RECOVERY_TASK_SLA_CONFLICT',
      );
    }

    const updatedRows = await tx.$queryRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET recovery_task_id = $3::int,
              recovery_sla_instance_id = $4::uuid,
              recovery_state = CASE
                WHEN status = 'requires_reconciliation'
                  AND recovery_claim_token IS NULL THEN 'requires_reconciliation'
                WHEN recovery_state IN ('claimed', 'provider_pending', 'retry_wait', 'blocked_authority')
                  THEN recovery_state
                WHEN status = 'pending' THEN 'provider_pending'
                ELSE 'queued'
              END,
              recovery_next_attempt_at = CASE
                WHEN status = 'requires_reconciliation'
                  AND recovery_claim_token IS NULL THEN NULL
                ELSE COALESCE(recovery_next_attempt_at, NOW())
              END,
              recovery_terminal_at = CASE
                WHEN status = 'requires_reconciliation'
                  AND recovery_claim_token IS NULL
                  THEN COALESCE(recovery_terminal_at, NOW())
                ELSE recovery_terminal_at
              END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING *`,
      tenant,
      id,
      Number(task.id),
      sla.id,
    );
    const updated = updatedRows[0];
    const created = task.inserted === true || sla.inserted === true || rearmed;
    if (created) {
      await insertRecoveryAuditTx(tx, {
        tenantId: tenant,
        row: updated,
        action: rearmed
          ? 'PAYMENT_GATEWAY_REFUND_RECOVERY_REARMED'
          : 'PAYMENT_GATEWAY_REFUND_RECOVERY_OPENED',
        metadata: {
          recovery_task_id: Number(task.id),
          recovery_sla_instance_id: String(sla.id),
        },
        dedupeKey: rearmed
          ? `rearmed:${id}:${updated.failure_code || 'provider_conflict'}:${updated.recovery_attempt_count}`
          : `opened:${id}`,
      });
    }
    if (parkFailure) {
      await insertRecoveryAuditTx(tx, {
        tenantId: tenant,
        row: updated,
        action: 'PAYMENT_GATEWAY_REFUND_RECOVERY_PARKED',
        metadata: {
          failure_code: updated.failure_code,
          failure_reason: updated.failure_reason,
          provider_refund_id: updated.provider_refund_id,
          recovery_task_id: Number(task.id),
          recovery_sla_instance_id: String(sla.id),
        },
        dedupeKey: `parked:${updated.failure_code || 'unknown'}:${updated.recovery_attempt_count}`,
      });
    }
    await queueFinanceRecoveryNotificationTx(tx, {
      tenantId: tenant,
      row: updated,
      outcome: updated.recovery_state === 'requires_reconciliation'
        ? 'requires_reconciliation'
        : 'opened',
      eventKey: parkFailure
        ? `parked:${updated.failure_code || 'unknown'}:${updated.recovery_attempt_count}`
        : (updated.recovery_state === 'requires_reconciliation'
          ? `requires_reconciliation:${updated.failure_code || 'unknown'}:${updated.recovery_attempt_count}`
          : null),
    });
  return { row: updated, created };
}

export async function ensureGatewayRefundRecoveryObligation({
  tenantId, gatewayRefundId, parkFailure = null, claimToken = null,
}) {
  const tenant = requireTenantId(tenantId);
  const id = positiveInt(gatewayRefundId, 'gatewayRefundId');
  const result = await setTenantTx(tenant, (tx) => ensureGatewayRefundRecoveryObligationTx({
    tx,
    tenantId: tenant,
    gatewayRefundId: id,
    parkFailure,
    claimToken,
  }));
  return { ...recoveryView(result.row), lost_fence: result.lostFence === true };
}

export async function listGatewayRefundRecovery({
  tenantId, include_terminal = false, limit = 50, offset = 0,
} = {}) {
  const tenant = requireTenantId(tenantId);
  const take = safeLimit(limit);
  const skip = Math.max(0, Number.parseInt(offset, 10) || 0);
  const rows = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `SELECT refund.*,
            task.status AS recovery_task_status,
            task.assigned_to_role AS recovery_task_owner_role,
            sla.status AS recovery_sla_status,
            sla.due_at AS recovery_sla_due_at
       FROM payment_gateway_refunds refund
       LEFT JOIN tasks task
         ON task.tenant_id = refund.tenant_id
        AND task.id = refund.recovery_task_id
       LEFT JOIN workflow_sla_instances sla
         ON sla.tenant_id = refund.tenant_id
        AND sla.id = refund.recovery_sla_instance_id
      WHERE refund.tenant_id = $1::uuid
        AND (
          $2::boolean
          OR (
            refund.recovery_state NOT IN ('succeeded', 'failed')
            AND refund.reconciled_at IS NULL
          )
        )
      ORDER BY COALESCE(refund.recovery_next_attempt_at, refund.updated_at) ASC, refund.id ASC
      LIMIT $3::int OFFSET $4::int`,
    tenant,
    include_terminal === true,
    take,
    skip,
  ));
  return { refunds: rows.map(recoveryView), limit: take, offset: skip };
}

const RECONCILIATION_DISPOSITIONS = new Set([
  'provider_processed', 'provider_failed',
  'provider_pending', 'provider_status_unknown',
]);
const TERMINAL_RECONCILIATION_DISPOSITIONS = new Set([
  'provider_failed',
]);
const RECONCILIATION_EVIDENCE_SOURCES = new Set([
  'provider_dashboard', 'provider_support', 'bank_statement', 'other_authoritative',
]);

function normalizeReconciliationEvidence(disposition, evidence) {
  const normalizedDisposition = String(disposition || '').trim().toLowerCase();
  if (!RECONCILIATION_DISPOSITIONS.has(normalizedDisposition)) {
    throw AppError.badRequest(
      'A supported structured reconciliation disposition is required',
      'PAYMENT_GATEWAY_REFUND_RECONCILIATION_DISPOSITION_REQUIRED',
    );
  }
  const source = String(evidence?.source || '').trim().toLowerCase();
  const reference = String(evidence?.reference || '').trim();
  const providerStatus = String(evidence?.provider_status || '').trim().toLowerCase();
  const notes = String(evidence?.notes || '').trim();
  const observedAt = new Date(evidence?.observed_at || '');
  const expectedStatus = normalizedDisposition === 'provider_status_unknown'
    ? 'unknown'
    : normalizedDisposition.replace('provider_', '');
  if (!RECONCILIATION_EVIDENCE_SOURCES.has(source)
      || reference.length < 6 || reference.length > 255
      || !Number.isFinite(observedAt.getTime())
      || observedAt.getTime() > Date.now()
      || providerStatus !== expectedStatus
      || notes.length > 500) {
    throw AppError.badRequest(
      'Disposition evidence must contain an allowed source, 6-255 char reference, observed_at, and matching provider_status',
      'PAYMENT_GATEWAY_REFUND_RECONCILIATION_EVIDENCE_INVALID',
    );
  }
  return {
    disposition: normalizedDisposition,
    evidence: {
      source,
      reference,
      observed_at: observedAt.toISOString(),
      provider_status: providerStatus,
      ...(notes ? { notes } : {}),
    },
  };
}

export async function resolveGatewayRefundRecoveryOperatorAction({
  tenantId, gatewayRefundId, actorUid, disposition, evidence,
}) {
  const tenant = requireTenantId(tenantId);
  const id = positiveInt(gatewayRefundId, 'gatewayRefundId');
  const actor = String(actorUid || '').trim();
  if (!actor) {
    throw AppError.forbidden(
      'An authenticated operator is required to review gateway refund reconciliation',
      'PAYMENT_GATEWAY_REFUND_RECONCILIATION_ACTOR_REQUIRED',
    );
  }
  const normalized = normalizeReconciliationEvidence(disposition, evidence);
  const terminalRequested = TERMINAL_RECONCILIATION_DISPOSITIONS
    .has(normalized.disposition);
  const requiresIndependentReviewer = ['provider_processed', 'provider_failed']
    .includes(normalized.disposition);
  await ensureGatewayRefundRecoveryObligation({ tenantId: tenant, gatewayRefundId: id });
  const result = await setTenantTx(tenant, async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT refund.*, billing.raised_by, billing.approved_by,
              (
                refund.recovery_state = 'claimed'
                AND refund.recovery_claim_token IS NOT NULL
                AND refund.recovery_lease_expires_at > NOW()
              ) IS TRUE AS recovery_claim_live
         FROM payment_gateway_refunds refund
         LEFT JOIN billing_refunds billing
           ON billing.tenant_id = refund.tenant_id
          AND billing.id = refund.billing_refund_id
        WHERE refund.tenant_id = $1::uuid AND refund.id = $2::int
        FOR UPDATE OF refund`,
      tenant,
      id,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Payment gateway refund not found');
    if (current.status !== 'requires_reconciliation') {
      throw AppError.conflict(
        'Gateway refund is not awaiting reconciliation',
        'PAYMENT_GATEWAY_REFUND_NOT_RECONCILABLE',
      );
    }
    const excludedActors = [current.raised_by, current.approved_by, current.initiated_by]
      .filter(Boolean).map((value) => String(value).toLowerCase());
    const terminal = terminalRequested && isExactProviderIdentifier(
      current.provider,
      'refund',
      current.provider_refund_id,
    );
    if (terminalRequested && current.provider_refund_id && !terminal) {
      throw AppError.conflict(
        'The stored provider refund identifier is not exact enough for terminal failure',
        'PAYMENT_GATEWAY_REFUND_PROVIDER_ID_INVALID',
      );
    }
    if (terminal && current.recovery_claim_live) {
      throw AppError.conflict(
        'Provider recovery is in progress; terminal reconciliation must wait for its lease',
        'PAYMENT_GATEWAY_REFUND_RECOVERY_IN_PROGRESS',
      );
    }
    if (requiresIndependentReviewer && excludedActors.includes(actor.toLowerCase())) {
      throw AppError.forbidden(
        'Processed or failed manual reconciliation requires an independent reviewer',
        'PAYMENT_GATEWAY_REFUND_RECONCILIATION_REVIEWER_NOT_INDEPENDENT',
        { excluded_authorities: ['raiser', 'approver', 'gateway_initiator'] },
      );
    }
    if (current.reconciled_at) {
      const same = String(current.reconciled_by || '').toLowerCase() === actor.toLowerCase()
        && current.reconciliation_disposition === normalized.disposition
        && current.reconciliation_evidence?.source === normalized.evidence.source
        && current.reconciliation_evidence?.reference === normalized.evidence.reference
        && current.reconciliation_evidence?.observed_at === normalized.evidence.observed_at
        && current.reconciliation_evidence?.provider_status
          === normalized.evidence.provider_status
        && (current.reconciliation_evidence?.notes || '')
          === (normalized.evidence.notes || '');
      if (!same) {
        throw AppError.conflict(
          'This gateway refund was already terminally reconciled',
          'PAYMENT_GATEWAY_REFUND_NOT_RECONCILABLE',
        );
      }
    }
    const note = `${normalized.disposition}: ${normalized.evidence.source} ${normalized.evidence.reference}`
      .slice(0, 500);
    const rows = await tx.$queryRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = CASE
                WHEN $6::boolean AND $3 = 'provider_failed' THEN 'failed'
                ELSE status
              END,
              failed_at = CASE
                WHEN $6::boolean AND $3 = 'provider_failed' THEN COALESCE(failed_at, NOW())
                ELSE failed_at
              END,
              failure_code = CASE
                WHEN $6::boolean AND $3 = 'provider_failed'
                  THEN COALESCE(failure_code, 'operator_verified_provider_failure')
                ELSE failure_code
              END,
              reconciliation_disposition = $3,
              reconciliation_evidence = $4::jsonb,
              reconciliation_reviewed_by = $5::uuid,
              reconciliation_reviewed_at = NOW(),
              reconciled_at = CASE WHEN $6::boolean THEN COALESCE(reconciled_at, NOW()) ELSE NULL END,
              reconciliation_note = CASE WHEN $6::boolean THEN COALESCE(reconciliation_note, $7) ELSE NULL END,
              reconciled_by = CASE WHEN $6::boolean THEN COALESCE(reconciled_by, $5::uuid) ELSE NULL END,
              recovery_state = CASE
                WHEN $6::boolean AND $3 = 'provider_failed' THEN 'failed'
                WHEN $6::boolean THEN 'requires_reconciliation'
                ELSE 'provider_pending'
              END,
              recovery_next_attempt_at = CASE WHEN $6::boolean THEN NULL ELSE NOW() END,
              recovery_terminal_at = CASE
                WHEN $6::boolean THEN COALESCE(recovery_terminal_at, NOW())
                ELSE NULL
              END,
              recovery_claim_token = NULL,
              recovery_claimed_at = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
        RETURNING *`,
      tenant,
      id,
      normalized.disposition,
      JSON.stringify(normalized.evidence),
      actor,
      terminal,
      note,
    );
    const updated = rows[0];
    if (updated.recovery_task_id) {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = CASE WHEN $3::boolean THEN 'completed' ELSE 'open' END,
                completed_at = CASE WHEN $3::boolean THEN COALESCE(completed_at, NOW()) ELSE NULL END,
                metadata = metadata || $4::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int`,
        tenant,
        Number(updated.recovery_task_id),
        terminal,
        JSON.stringify({
          recovery_state: updated.recovery_state,
          operator_reviewed: true,
          terminal,
          reviewed_by: actor,
          reconciliation_disposition: normalized.disposition,
          reconciliation_evidence: normalized.evidence,
        }),
      );
    }
    if (updated.recovery_sla_instance_id) {
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET status = CASE
                  WHEN NOT $3::boolean AND due_at < NOW() THEN 'breached'
                  WHEN NOT $3::boolean THEN 'active'
                  WHEN due_at < NOW() AND status = 'escalated' THEN 'escalated'
                  WHEN due_at < NOW() THEN 'breached'
                  ELSE 'completed'
                END,
                completed_at = CASE WHEN $3::boolean THEN COALESCE(completed_at, NOW()) ELSE NULL END,
                breached_at = CASE WHEN due_at < NOW() THEN COALESCE(breached_at, due_at) ELSE breached_at END,
                metadata = metadata || $4::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND status <> 'cancelled'`,
        tenant,
        String(updated.recovery_sla_instance_id),
        terminal,
        JSON.stringify({
          ...(terminal ? {
            completed_via: 'domain_evidence',
            completed_by_task: String(updated.recovery_task_id),
            completion_evidence: {
              kind: 'payment_gateway_refund_operator_reconciliation',
              resource_type: 'payment_gateway_refunds',
              resource_id: String(id),
              disposition: normalized.disposition,
              evidence: normalized.evidence,
              reviewed_by: actor,
            },
          } : {}),
          gateway_refund_id: id,
          reviewed_by: actor,
          reconciliation_disposition: normalized.disposition,
        }),
      );
    }
    const evidenceFingerprint = sha256Hex(JSON.stringify(normalized.evidence));
    await insertRecoveryAuditTx(tx, {
      tenantId: tenant,
      row: updated,
      action: terminal
        ? 'PAYMENT_GATEWAY_REFUND_RECOVERY_OPERATOR_RESOLVED'
        : 'PAYMENT_GATEWAY_REFUND_RECOVERY_OPERATOR_REVIEWED',
      actorUid: actor,
      metadata: {
        recovery_task_id: updated.recovery_task_id == null
          ? null
          : Number(updated.recovery_task_id),
        recovery_sla_instance_id: updated.recovery_sla_instance_id,
        reconciliation_disposition: normalized.disposition,
        reconciliation_evidence: normalized.evidence,
        terminal,
      },
      dedupeKey: `operator-review:${actor}:${normalized.disposition}:${evidenceFingerprint}`,
    });
    await queueFinanceRecoveryNotificationTx(tx, {
      tenantId: tenant,
      row: updated,
      outcome: terminal ? 'operator_resolved' : 'operator_review_pending',
    });
    return updated;
  });
  return recoveryView(result);
}

export async function claimGatewayRefundRecoveryBatch({
  tenantId, limit = DEFAULT_BATCH_LIMIT, onlyId = null, force = false,
} = {}) {
  const tenant = requireTenantId(tenantId);
  const take = safeLimit(limit);
  const targetId = onlyId == null ? null : positiveInt(onlyId, 'gatewayRefundId');
  return setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `WITH candidates AS (
       SELECT refund.id
         FROM payment_gateway_refunds refund
        WHERE refund.tenant_id = $1::uuid
          AND (
            refund.status IN ('initiated', 'pending')
            OR (
              (refund.status = 'processed' AND refund.recovery_state <> 'succeeded')
              OR (refund.status = 'failed' AND refund.recovery_state <> 'failed')
            )
            OR (
              refund.status = 'requires_reconciliation'
              AND refund.provider_refund_id IS NOT NULL
              AND refund.reconciled_at IS NULL
              AND (
                $3::boolean
                OR refund.reconciliation_disposition IN (
                  'provider_processed', 'provider_pending', 'provider_status_unknown'
                )
              )
            )
          )
          AND refund.recovery_state IN (
            'queued', 'provider_pending', 'retry_wait', 'blocked_authority',
            'requires_reconciliation', 'claimed'
          )
          AND ($3::boolean OR refund.recovery_state <> 'blocked_authority')
          AND ($2::int IS NULL OR refund.id = $2::int)
          AND ($3::boolean OR refund.recovery_next_attempt_at IS NULL
               OR refund.recovery_next_attempt_at <= NOW())
          AND (
            refund.recovery_claim_token IS NULL
            OR refund.recovery_lease_expires_at <= NOW()
          )
        ORDER BY COALESCE(refund.recovery_next_attempt_at, refund.initiated_at), refund.id
        LIMIT $4::int
        FOR UPDATE SKIP LOCKED
     ), claimed AS (
       UPDATE payment_gateway_refunds refund
          SET recovery_state = 'claimed',
              recovery_claim_token = gen_random_uuid(),
              recovery_claimed_at = NOW(),
              recovery_lease_expires_at = NOW() + make_interval(mins => $5::int),
              recovery_last_attempt_at = NOW(),
              recovery_attempt_count = LEAST(recovery_attempt_count + 1, 100),
              recovery_terminal_at = NULL,
              updated_at = NOW()
         FROM candidates
        WHERE refund.tenant_id = $1::uuid
          AND refund.id = candidates.id
       RETURNING refund.*
     )
     SELECT claimed.*,
            orders.patient_uid::text,
            orders.provider_config_id,
            configs.enabled AS provider_config_enabled,
            configs.key_id,
            configs.key_secret_ciphertext,
            configs.provider AS config_provider,
            configs.environment AS config_environment,
            billing.approved_by AS billing_approved_by,
            billing.approved_at AS billing_approved_at,
            EXISTS (
              SELECT 1
                FROM users initiator
               WHERE initiator.tenant_id = claimed.tenant_id
                 AND initiator.uid = claimed.initiated_by
            ) AS stored_initiator_tenant_valid,
            claimed.provider_request_fingerprint = payment_gateway_refund_request_fingerprint(
              claimed.tenant_id,
              claimed.provider,
              claimed.provider_payment_id,
              claimed.billing_refund_id,
              claimed.gateway_order_id,
              claimed.amount,
              claimed.currency,
              claimed.provider_idempotency_key
            ) AS request_fingerprint_valid
       FROM claimed
       JOIN payment_gateway_orders orders
         ON orders.tenant_id = claimed.tenant_id
        AND orders.id = claimed.gateway_order_id
       LEFT JOIN payment_gateway_provider_configs configs
         ON configs.tenant_id = orders.tenant_id
        AND configs.id = orders.provider_config_id
       LEFT JOIN billing_refunds billing
         ON billing.tenant_id = claimed.tenant_id
        AND billing.id = claimed.billing_refund_id
      ORDER BY claimed.id`,
    tenant,
    targetId,
    force === true,
    take,
    RECOVERY_LEASE_MINUTES,
  ));
}

export async function requeueGatewayRefundAuthorityBlockedTx({
  tx, tenantId, provider, environment, actorUid = null,
}) {
  const tenant = requireTenantId(tenantId);
  const rows = await tx.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds refund
          SET recovery_state = 'queued',
              recovery_next_attempt_at = NOW(),
              recovery_last_error_code = NULL,
              recovery_last_error_reason = NULL,
              updated_at = NOW()
         FROM payment_gateway_orders orders,
              payment_gateway_provider_configs config
        WHERE refund.tenant_id = $1::uuid
          AND refund.recovery_state = 'blocked_authority'
          AND refund.recovery_claim_token IS NULL
          AND refund.gateway_order_id = orders.id
          AND orders.tenant_id = refund.tenant_id
          AND orders.provider_config_id = config.id
          AND config.tenant_id = refund.tenant_id
          AND config.provider = $2
          AND config.environment = $3
          AND config.enabled = TRUE
        RETURNING refund.*`,
    tenant,
    String(provider),
    String(environment),
  );
  for (const row of rows) {
    if (row.recovery_task_id) {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
              SET status = 'open', completed_at = NULL,
                  metadata = metadata || $3::jsonb,
                  updated_at = NOW()
            WHERE tenant_id = $1::uuid AND id = $2::int`,
        tenant,
        Number(row.recovery_task_id),
        JSON.stringify({
          recovery_state: 'queued',
          authority_requeued: true,
        }),
      );
    }
    await insertRecoveryAuditTx(tx, {
      tenantId: tenant,
      row,
      action: 'PAYMENT_GATEWAY_REFUND_RECOVERY_AUTHORITY_REQUEUED',
      actorUid,
      metadata: { provider: row.provider, environment: row.environment },
      dedupeKey: `authority-requeued:${row.recovery_attempt_count}`,
    });
    await queueFinanceRecoveryNotificationTx(tx, {
      tenantId: tenant,
      row,
      outcome: 'authority_requeued',
    });
  }
  return rows.map(recoveryView);
}

async function markRetry({
  tenantId, row, error, authorityBlocked = false, forceReconciliation = false,
}) {
  const tenant = requireTenantId(tenantId);
  const attempts = Number(row.recovery_attempt_count || 0);
  const exhausted = forceReconciliation
    || (!authorityBlocked && attempts >= RECOVERY_MAX_ATTEMPTS);
  const errorCode = String(error?.code || 'PAYMENT_GATEWAY_REFUND_RECOVERY_FAILED').slice(0, 100);
  const reason = String(error?.message || 'Provider refund recovery failed').slice(0, 500);
  const failureCode = forceReconciliation ? errorCode : 'provider_recovery_exhausted';
  const backoff = authorityBlocked ? null : gatewayRefundRecoveryBackoffMinutes(attempts);
  let auditAction = 'PAYMENT_GATEWAY_REFUND_RECOVERY_RETRY_SCHEDULED';
  if (forceReconciliation) {
    auditAction = 'PAYMENT_GATEWAY_REFUND_RECOVERY_REQUIRES_RECONCILIATION';
  } else if (exhausted) {
    auditAction = 'PAYMENT_GATEWAY_REFUND_RECOVERY_EXHAUSTED';
  } else if (authorityBlocked) {
    auditAction = 'PAYMENT_GATEWAY_REFUND_RECOVERY_AUTHORITY_BLOCKED';
  }
  const updated = await setTenantTx(tenant, async (tx) => {
    const rows = await tx.$queryRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET status = CASE WHEN $5::boolean THEN 'requires_reconciliation' ELSE status END,
              recovery_state = CASE
                WHEN $5::boolean THEN 'requires_reconciliation'
                WHEN $6::boolean THEN 'blocked_authority'
                ELSE 'retry_wait'
              END,
              recovery_next_attempt_at = CASE
                WHEN $5::boolean OR $6::boolean THEN NULL
                ELSE NOW() + make_interval(mins => $7::int)
              END,
              recovery_last_error_code = $3,
              recovery_last_error_reason = $4,
              recovery_terminal_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END,
              recovery_claim_token = NULL,
              recovery_claimed_at = NULL,
              recovery_lease_expires_at = NULL,
              failure_code = CASE WHEN $5::boolean THEN $9::varchar ELSE failure_code END,
              failure_reason = CASE WHEN $5::boolean THEN $4 ELSE failure_reason END,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid
          AND id = $2::int
          AND recovery_claim_token = $8::uuid
          AND recovery_state = 'claimed'
        RETURNING *`,
      tenant,
      Number(row.id),
      errorCode,
      reason,
      exhausted,
      authorityBlocked,
      backoff,
      String(row.recovery_claim_token),
      failureCode,
    );
    const current = rows[0] || null;
    if (!current) return null;
    if (current.recovery_task_id) {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = $3,
                metadata = metadata || $4::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int
            AND (
              status IN ('open', 'in_progress', 'blocked', 'overdue')
              OR ($3::text <> 'requires_reconciliation' AND status = 'completed')
            )`,
        tenant,
        Number(current.recovery_task_id),
        exhausted || authorityBlocked ? 'blocked' : 'open',
        JSON.stringify({
          recovery_state: current.recovery_state,
          recovery_last_error_code: errorCode,
          recovery_attempt_count: attempts,
        }),
      );
    }
    await insertRecoveryAuditTx(tx, {
      tenantId: tenant,
      row: current,
      action: auditAction,
      metadata: { error_code: errorCode, attempt_count: attempts, backoff_minutes: backoff },
      dedupeKey: `attempt:${attempts}:${errorCode}`,
    });
    if (exhausted || authorityBlocked) {
      await queueFinanceRecoveryNotificationTx(tx, {
        tenantId: tenant,
        row: current,
        outcome: exhausted ? 'requires_reconciliation' : 'blocked_authority',
      });
    }
    return current;
  });
  if (!updated) return { ...recoveryView(row), lost_fence: true };
  return { ...recoveryView(updated), lost_fence: false };
}

export async function projectGatewayRefundRecoveryTerminal({
  tenantId, gatewayRefundId, outcome, claimToken = null, actorUid = null,
}) {
  const tenant = requireTenantId(tenantId);
  const id = positiveInt(gatewayRefundId, 'gatewayRefundId');
  if (!['succeeded', 'failed', 'requires_reconciliation'].includes(outcome)) {
    throw AppError.badRequest('Unknown gateway refund recovery terminal outcome');
  }
  const result = await setTenantTx(tenant, async (tx) => {
    const currentRows = await tx.$queryRawUnsafe(
      `SELECT * FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int
        FOR UPDATE`,
      tenant,
      id,
    );
    const current = currentRows[0];
    if (!current) throw AppError.notFound('Payment gateway refund not found');
    const expectedStatus = {
      succeeded: 'processed',
      failed: 'failed',
      requires_reconciliation: 'requires_reconciliation',
    }[outcome];
    if (current.status !== expectedStatus) {
      throw AppError.conflict(
        'Recovery projection does not match the durable gateway refund status',
        'PAYMENT_GATEWAY_REFUND_RECOVERY_STATUS_MISMATCH',
        { expected_status: expectedStatus, actual_status: current.status },
      );
    }
    if (claimToken && String(current.recovery_claim_token || '') !== String(claimToken)) {
      return { row: current, changed: false, lostFence: true };
    }
    const already = current.recovery_state === outcome && current.recovery_terminal_at;
    const rows = await tx.$queryRawUnsafe(
      `UPDATE payment_gateway_refunds
          SET recovery_state = $3,
              recovery_terminal_at = COALESCE(recovery_terminal_at, NOW()),
              recovery_next_attempt_at = NULL,
              provider_status_checked_at = NOW(),
              recovery_last_error_code = CASE WHEN $3 = 'succeeded' THEN NULL ELSE recovery_last_error_code END,
              recovery_last_error_reason = CASE WHEN $3 = 'succeeded' THEN NULL ELSE recovery_last_error_reason END,
              recovery_claim_token = NULL,
              recovery_claimed_at = NULL,
              recovery_lease_expires_at = NULL,
              updated_at = NOW()
        WHERE tenant_id = $1::uuid AND id = $2::int
          AND ($4::uuid IS NULL OR (
            recovery_claim_token = $4::uuid AND recovery_state = 'claimed'
          ))
        RETURNING *`,
      tenant,
      id,
      outcome,
      claimToken ? String(claimToken) : null,
    );
    const updated = rows[0];
    if (!updated) return { row: current, changed: false, lostFence: true };
    if (updated.recovery_task_id) {
      await tx.$executeRawUnsafe(
        `UPDATE tasks
            SET status = CASE WHEN $3 = 'requires_reconciliation' THEN 'blocked' ELSE 'completed' END,
                completed_at = CASE
                  WHEN $3 = 'requires_reconciliation' THEN NULL
                  ELSE COALESCE(completed_at, NOW())
                END,
                metadata = metadata || $4::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::int
            AND (
              status IN ('open', 'in_progress', 'blocked', 'overdue')
              OR ($3::text <> 'requires_reconciliation' AND status = 'completed')
            )`,
        tenant,
        Number(updated.recovery_task_id),
        outcome,
        JSON.stringify({
          recovery_state: outcome,
          provider_status_checked_at: new Date().toISOString(),
        }),
      );
    }
    if (updated.recovery_sla_instance_id && outcome !== 'requires_reconciliation') {
      await tx.$executeRawUnsafe(
        `UPDATE workflow_sla_instances
            SET status = CASE
                  WHEN completed_at IS NOT NULL THEN status
                  WHEN due_at < NOW() AND status = 'escalated' THEN 'escalated'
                  WHEN due_at < NOW() THEN 'breached'
                  ELSE 'completed'
                END,
                completed_at = COALESCE(completed_at, NOW()),
                breached_at = CASE WHEN due_at < NOW() THEN COALESCE(breached_at, due_at) ELSE breached_at END,
                metadata = metadata || $4::jsonb,
                updated_at = NOW()
          WHERE tenant_id = $1::uuid AND id = $2::uuid
            AND status <> 'cancelled'`,
        tenant,
        String(updated.recovery_sla_instance_id),
        outcome,
        JSON.stringify({
          completed_via: 'domain_evidence',
          completed_by_task: String(updated.recovery_task_id),
          completion_evidence: {
            kind: 'payment_gateway_refund_provider_status',
            resource_type: 'payment_gateway_refunds',
            resource_id: String(id),
            provider_status: updated.status,
            provider_refund_id: updated.provider_refund_id,
          },
          gateway_refund_id: id,
          provider_outcome: outcome,
        }),
      );
    }
    if (!already) {
      await insertRecoveryAuditTx(tx, {
        tenantId: tenant,
        row: updated,
        action: `PAYMENT_GATEWAY_REFUND_RECOVERY_${outcome.toUpperCase()}`,
        actorUid,
        metadata: { provider_outcome: outcome },
        dedupeKey: `terminal:${outcome}`,
      });
    }
    if (updated.recovery_task_id || outcome !== 'succeeded') {
      await queueFinanceRecoveryNotificationTx(tx, {
        tenantId: tenant,
        row: updated,
        outcome,
      });
    }
    return { row: updated, changed: !already, lostFence: false };
  });
  return { ...recoveryView(result.row), lost_fence: result.lostFence };
}

async function markProviderPending({ tenantId, row }) {
  const tenant = requireTenantId(tenantId);
  const backoff = gatewayRefundRecoveryBackoffMinutes(row.recovery_attempt_count);
  const rows = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET recovery_state = 'provider_pending',
            recovery_next_attempt_at = NOW() + make_interval(mins => $3::int),
            provider_status_checked_at = NOW(),
            recovery_last_error_code = NULL,
            recovery_last_error_reason = NULL,
            recovery_claim_token = NULL,
            recovery_claimed_at = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::int
        AND recovery_claim_token = $4::uuid
        AND recovery_state = 'claimed'
      RETURNING *`,
    tenant,
    Number(row.id),
    backoff,
    String(row.recovery_claim_token),
  ));
  if (!rows[0]) {
    return { ...recoveryView(row), lost_fence: true };
  }
  return { ...recoveryView(rows[0]), lost_fence: false };
}

async function renewGatewayRefundRecoveryClaim({ tenantId, row }) {
  const tenant = requireTenantId(tenantId);
  const rows = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET recovery_claimed_at = NOW(),
            recovery_lease_expires_at = NOW() + make_interval(mins => $4::int),
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::int
        AND recovery_claim_token = $3::uuid
        AND recovery_state = 'claimed'
      RETURNING *`,
    tenant,
    Number(row.id),
    String(row.recovery_claim_token),
    RECOVERY_LEASE_MINUTES,
  ));
  return rows[0] || null;
}

async function releaseClaimAfterObligationFailure({ tenantId, row, error }) {
  const tenant = requireTenantId(tenantId);
  const errorCode = String(
    error?.code || 'PAYMENT_GATEWAY_REFUND_RECOVERY_OBLIGATION_FAILED',
  ).slice(0, 100);
  const reason = String(
    error?.message || 'Gateway refund recovery obligation could not be persisted',
  ).slice(0, 500);
  const rows = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `UPDATE payment_gateway_refunds
        SET recovery_state = 'retry_wait',
            recovery_attempt_count = GREATEST(recovery_attempt_count - 1, 0),
            recovery_next_attempt_at = NOW() + INTERVAL '1 minute',
            recovery_last_error_code = $4::varchar,
            recovery_last_error_reason = $5::text,
            recovery_terminal_at = NULL,
            recovery_claim_token = NULL,
            recovery_claimed_at = NULL,
            recovery_lease_expires_at = NULL,
            updated_at = NOW()
      WHERE tenant_id = $1::uuid AND id = $2::int
        AND recovery_claim_token = $3::uuid
        AND recovery_state = 'claimed'
      RETURNING *`,
    tenant,
    Number(row.id),
    String(row.recovery_claim_token),
    errorCode,
    reason,
  ));
  return rows[0] || null;
}

async function recoverClaimedRow({ tenantId, row, actorUid = null }) {
  const tenant = requireTenantId(tenantId);
  if (row.status === 'processed') {
    return projectGatewayRefundRecoveryTerminal({
      tenantId: tenant,
      gatewayRefundId: row.id,
      outcome: 'succeeded',
      claimToken: row.recovery_claim_token,
      actorUid,
    });
  }
  if (row.status === 'failed') {
    return projectGatewayRefundRecoveryTerminal({
      tenantId: tenant,
      gatewayRefundId: row.id,
      outcome: 'failed',
      claimToken: row.recovery_claim_token,
      actorUid,
    });
  }
  if (row.request_fingerprint_valid !== true) {
    return markRetry({
      tenantId: tenant,
      row,
      error: new AppError(
        'The durable provider request fingerprint does not match the refund intent',
        409,
        'PAYMENT_GATEWAY_REFUND_REQUEST_FINGERPRINT_MISMATCH',
      ),
      forceReconciliation: true,
    });
  }

  const initiatedAt = new Date(row.initiated_at).getTime();
  const approvedAt = new Date(row.billing_approved_at).getTime();
  const authorityValid = row.stored_initiator_tenant_valid === true
    && Boolean(row.initiated_by)
    && Boolean(row.billing_approved_by)
    && Number.isFinite(initiatedAt)
    && Number.isFinite(approvedAt)
    && initiatedAt > approvedAt
    && String(row.initiated_by).toLowerCase()
      !== String(row.billing_approved_by).toLowerCase();
  if (!authorityValid) {
    return markRetry({
      tenantId: tenant,
      row,
      error: new AppError(
        'The durable gateway refund lacks independent same-tenant post-approval authority',
        409,
        'PAYMENT_GATEWAY_REFUND_INITIATOR_AUTHORITY_INVALID',
      ),
      forceReconciliation: true,
    });
  }

  if (!row.provider_refund_id && row.provider_request_replay_authorized !== true) {
    return markRetry({
      tenantId: tenant,
      row,
      error: new AppError(
        'The historical refund intent has no proven provider request replay identity',
        409,
        'PAYMENT_GATEWAY_REFUND_LEGACY_RECONCILIATION_REQUIRED',
      ),
      forceReconciliation: true,
    });
  }

  const gatewayContext = await resolveGatewayContext(tenant);
  const exactConfig = gatewayContext.enabled
    && Number(gatewayContext.config?.id) === Number(row.provider_config_id)
    && gatewayContext.config?.provider === row.provider
    && gatewayContext.config?.environment === row.environment;
  if (!exactConfig || row.provider_config_enabled !== true
      || row.config_provider !== row.provider
      || row.config_environment !== row.environment) {
    return markRetry({
      tenantId: tenant,
      row,
      error: new AppError(
        'The exact provider configuration is not enabled for outbound refund recovery',
        403,
        'PAYMENT_GATEWAY_REFUND_RECOVERY_PROVIDER_AUTHORITY_REQUIRED',
      ),
      authorityBlocked: true,
    });
  }

  const adapter = resolveAdapter(row.provider);
  let keySecret = null;
  try {
    keySecret = gatewayContext.config.key_secret_ciphertext
      ? decryptField(gatewayContext.config.key_secret_ciphertext)
      : null;
  } catch (error) {
    return markRetry({
      tenantId: tenant,
      row,
      error: new AppError(
        'The exact provider credentials cannot be decrypted for refund recovery',
        403,
        'PAYMENT_GATEWAY_REFUND_RECOVERY_PROVIDER_CREDENTIALS_REQUIRED',
      ),
      authorityBlocked: true,
    });
  }
  if (row.provider !== 'dry_run' && (!gatewayContext.config.key_id || !keySecret)) {
    return markRetry({
      tenantId: tenant,
      row,
      error: new AppError(
        'The exact provider credentials are unavailable for refund recovery',
        403,
        'PAYMENT_GATEWAY_REFUND_RECOVERY_PROVIDER_CREDENTIALS_REQUIRED',
      ),
      authorityBlocked: true,
    });
  }
  const providerArgs = {
    keyId: gatewayContext.config.key_id,
    keySecret,
    providerPaymentId: row.provider_payment_id,
    amountPaise: toPaise(row.amount),
    currency: row.currency,
    billingRefundId: Number(row.billing_refund_id),
  };
  let evidence;
  if (!row.provider_refund_id) {
    const liveClaim = await renewGatewayRefundRecoveryClaim({ tenantId: tenant, row });
    if (!liveClaim) return { ...recoveryView(row), lost_fence: true };
    evidence = await adapter.createRefund({
      ...providerArgs,
      receipt: refundReceipt(row),
      notes: { billing_refund_id: String(row.billing_refund_id) },
      idempotencyKey: row.provider_idempotency_key,
    });
    const created = await applyGatewayRefundProviderEvidence({
      tenantId: tenant,
      config: gatewayContext.config,
      evidence,
      claimToken: row.recovery_claim_token,
    });
    if (created.outcome === 'lost_fence') {
      return { ...recoveryView(row), lost_fence: true };
    }
    if (created.outcome === 'refund_processed') {
      return projectGatewayRefundRecoveryTerminal({
        tenantId: tenant,
        gatewayRefundId: row.id,
        outcome: 'succeeded',
        claimToken: row.recovery_claim_token,
        actorUid,
      });
    }
    if (created.outcome === 'refund_failed_recorded') {
      return projectGatewayRefundRecoveryTerminal({
        tenantId: tenant,
        gatewayRefundId: row.id,
        outcome: 'failed',
        claimToken: row.recovery_claim_token,
        actorUid,
      });
    }
    if (created.outcome === 'requires_reconciliation' && created.recovery) {
      return created.recovery;
    }
    if (created.outcome === 'requires_reconciliation' || created.outcome === 'ignored') {
      return projectGatewayRefundRecoveryTerminal({
        tenantId: tenant,
        gatewayRefundId: row.id,
        outcome: 'requires_reconciliation',
        claimToken: row.recovery_claim_token,
        actorUid,
      });
    }
  }

  const providerRefundId = evidence?.providerRefundId || row.provider_refund_id;
  if (!providerRefundId) {
    throw new AppError(
      'Provider recovery did not return a refund id',
      502,
      'PAYMENT_GATEWAY_UPSTREAM_UNRESOLVED',
    );
  }
  const liveClaim = await renewGatewayRefundRecoveryClaim({ tenantId: tenant, row });
  if (!liveClaim) return { ...recoveryView(row), lost_fence: true };
  evidence = await adapter.fetchRefund({
    ...providerArgs,
    providerRefundId,
  });
  const applied = await applyGatewayRefundProviderEvidence({
    tenantId: tenant,
    config: gatewayContext.config,
    evidence,
    claimToken: row.recovery_claim_token,
  });

  if (applied.outcome === 'lost_fence') {
    return { ...recoveryView(row), lost_fence: true };
  }

  if (applied.outcome === 'refund_pending') {
    return markProviderPending({ tenantId: tenant, row });
  }
  if (applied.outcome === 'requires_reconciliation' && applied.recovery) {
    return applied.recovery;
  }
  if (applied.outcome === 'requires_reconciliation' || applied.outcome === 'ignored') {
    return projectGatewayRefundRecoveryTerminal({
      tenantId: tenant,
      gatewayRefundId: row.id,
      outcome: 'requires_reconciliation',
      claimToken: row.recovery_claim_token,
      actorUid,
    });
  }
  if (applied.outcome === 'refund_failed_recorded') {
    return projectGatewayRefundRecoveryTerminal({
      tenantId: tenant,
      gatewayRefundId: row.id,
      outcome: 'failed',
      claimToken: row.recovery_claim_token,
      actorUid,
    });
  }

  const statusRows = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
    `SELECT status FROM payment_gateway_refunds
      WHERE tenant_id = $1::uuid AND id = $2::int`,
    tenant,
    Number(row.id),
  ));
  const status = statusRows[0]?.status;
  if (status === 'processed') {
    return projectGatewayRefundRecoveryTerminal({
      tenantId: tenant,
      gatewayRefundId: row.id,
      outcome: 'succeeded',
      claimToken: row.recovery_claim_token,
      actorUid,
    });
  }
  if (status === 'failed') {
    return projectGatewayRefundRecoveryTerminal({
      tenantId: tenant,
      gatewayRefundId: row.id,
      outcome: 'failed',
      claimToken: row.recovery_claim_token,
      actorUid,
    });
  }
  return markProviderPending({ tenantId: tenant, row });
}

export async function recoverGatewayRefundNow({ tenantId, gatewayRefundId, actorUid = null }) {
  requireRecoveryActivation();
  const tenant = requireTenantId(tenantId);
  const id = positiveInt(gatewayRefundId, 'gatewayRefundId');
  await ensureGatewayRefundRecoveryObligation({ tenantId: tenant, gatewayRefundId: id });
  const claimed = await claimGatewayRefundRecoveryBatch({
    tenantId: tenant,
    onlyId: id,
    limit: 1,
    force: true,
  });
  if (!claimed.length) {
    const rows = await setTenantTx(tenant, (tx) => tx.$queryRawUnsafe(
      `SELECT * FROM payment_gateway_refunds
        WHERE tenant_id = $1::uuid AND id = $2::int`,
      tenant,
      id,
    ));
    const existing = rows[0];
    if (!existing) throw AppError.notFound('Payment gateway refund not found');
    if (existing.status === 'processed') {
      return projectGatewayRefundRecoveryTerminal({
        tenantId: tenant,
        gatewayRefundId: id,
        outcome: 'succeeded',
        actorUid,
      });
    }
    if (existing.status === 'failed') {
      return projectGatewayRefundRecoveryTerminal({
        tenantId: tenant,
        gatewayRefundId: id,
        outcome: 'failed',
        actorUid,
      });
    }
    if (existing.status === 'requires_reconciliation' && !existing.provider_refund_id) {
      throw AppError.conflict(
        'This reconciled refund has no provider identity that can be polled safely',
        'PAYMENT_GATEWAY_REFUND_RECOVERY_NOT_AUTOMATABLE',
      );
    }
    throw AppError.conflict(
      'Gateway refund recovery is already leased by another worker',
      'PAYMENT_GATEWAY_REFUND_RECOVERY_IN_PROGRESS',
    );
  }
  try {
    return await recoverClaimedRow({ tenantId: tenant, row: claimed[0], actorUid });
  } catch (error) {
    return markRetry({
      tenantId: tenant,
      row: claimed[0],
      error,
      forceReconciliation:
        error?.code === 'PAYMENT_GATEWAY_REFUND_IDEMPOTENCY_CONFLICT',
    });
  }
}

export async function runGatewayRefundRecoverySweep({
  tenantId, limit = DEFAULT_BATCH_LIMIT,
} = {}) {
  const tenant = requireTenantId(tenantId);
  const take = safeLimit(limit);
  if (!isGatewayRefundRecoveryEnabled()) {
    return {
      enabled: false,
      activation_gate: 'PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED=true',
      claimed: 0,
      processed: 0,
      failed: 0,
      lost_fence: 0,
      persistence_failures: [],
    };
  }
  let claimedCount = 0;
  let processed = 0;
  let failed = 0;
  let lostFence = 0;
  const persistenceFailures = [];
  for (let claimIndex = 0; claimIndex < take; claimIndex += 1) {
    const claimed = await claimGatewayRefundRecoveryBatch({ tenantId: tenant, limit: 1 });
    if (!claimed.length) break;
    const row = claimed[0];
    claimedCount += 1;
    let obligation;
    try {
      obligation = await ensureGatewayRefundRecoveryObligation({
        tenantId: tenant,
        gatewayRefundId: row.id,
        claimToken: row.recovery_claim_token,
      });
    } catch (obligationError) {
      failed += 1;
      try {
        const released = await releaseClaimAfterObligationFailure({
          tenantId: tenant,
          row,
          error: obligationError,
        });
        if (!released) lostFence += 1;
      } catch (persistenceError) {
        persistenceFailures.push({
          gateway_refund_id: Number(row.id),
          code: String(persistenceError?.code || 'PAYMENT_GATEWAY_REFUND_RECOVERY_PERSISTENCE_FAILED'),
          message: String(persistenceError?.message || 'Failed to release refund recovery claim')
            .slice(0, 500),
        });
      }
      continue;
    }
    if (obligation.lost_fence) {
      lostFence += 1;
      continue;
    }
    try {
      const outcome = await recoverClaimedRow({ tenantId: tenant, row });
      if (outcome?.lost_fence) {
        lostFence += 1;
        continue;
      }
      processed += 1;
    } catch (error) {
      failed += 1;
      try {
        const retry = await markRetry({
          tenantId: tenant,
          row,
          error,
          forceReconciliation:
            error?.code === 'PAYMENT_GATEWAY_REFUND_IDEMPOTENCY_CONFLICT',
        });
        if (retry?.lost_fence) lostFence += 1;
      } catch (persistenceError) {
        persistenceFailures.push({
          gateway_refund_id: Number(row.id),
          code: String(persistenceError?.code || 'PAYMENT_GATEWAY_REFUND_RECOVERY_PERSISTENCE_FAILED'),
          message: String(persistenceError?.message || 'Failed to persist gateway refund recovery state')
            .slice(0, 500),
        });
      }
    }
  }
  return {
    enabled: true,
    claimed: claimedCount,
    processed,
    failed,
    lost_fence: lostFence,
    persistence_failures: persistenceFailures,
  };
}

export const gatewayRefundRecoveryContract = Object.freeze({
  activationGate: 'PAYMENT_GATEWAY_REFUND_RECOVERY_ENABLED=true',
  providerAuthority: 'exact enabled provider config plus decryptable credentials',
  providerSuccessAuthority: 'exact provider status=processed evidence',
  refundAuthority: 'billing_refunds approval and payout rail',
  leaseMinutes: RECOVERY_LEASE_MINUTES,
  maxAttempts: RECOVERY_MAX_ATTEMPTS,
  ownerRoles: RECOVERY_ROLES,
  requestIdentity: 'payment_gateway_refunds.provider_request_fingerprint',
  claimIdentity: 'recovery_claim_token',
});
