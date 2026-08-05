import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { acknowledgeTask } from '../workflow/taskService.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { hashCanonicalValue } from '../downtime/continuityPackCanonical.js';

const OBLIGATION_CONTRACT = 'late_pending_only';
const OBLIGATION_VERSION = 1;

function deterministicUuid(value) {
  const chars = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function appendExternalRecoveryCriticalReviewObligationTx({
  tx,
  tenantId,
  recoveryInboxId,
  interfaceFamily,
  task,
  patientUid,
  criticalResultIds,
  sourceOccurredAt
} = {}) {
  if (!tx || typeof tx.$queryRawUnsafe !== 'function') {
    throw AppError.internal(
      'Late-critical recovery obligation requires the recovery transaction',
      'EXTERNAL_RECOVERY_CRITICAL_REVIEW_TX_REQUIRED'
    );
  }
  const resultIds = [...new Set((criticalResultIds || []).map(Number))]
    .filter(Number.isSafeInteger)
    .sort((a, b) => a - b);
  if (!['I01', 'I02'].includes(interfaceFamily) || resultIds.length === 0) return null;
  if (!task?.id || task.priority !== 'critical' || task.assigned_to_role !== 'DUTY_DOCTOR') {
    throw AppError.internal(
      'Late-critical recovery task does not carry the required human channel',
      'EXTERNAL_RECOVERY_CRITICAL_REVIEW_TASK_INVALID'
    );
  }
  const identity = {
    contract: OBLIGATION_CONTRACT,
    contract_version: OBLIGATION_VERSION,
    tenant_id: tenantId,
    recovery_inbox_id: recoveryInboxId,
    interface_family: interfaceFamily,
    task_id: Number(task.id),
    patient_uid: patientUid,
    critical_result_ids: resultIds
  };
  const obligationId = deterministicUuid(
    `external-recovery-critical-review:${hashCanonicalValue(identity)}`
  );
  const rows = await tx.$queryRawUnsafe(
    `SELECT public.external_recovery_critical_review_obligation_append($1::jsonb) AS obligation`,
    JSON.stringify({
      ...identity,
      id: obligationId,
      source_occurred_at: new Date(sourceOccurredAt).toISOString(),
      recipient_class: 'DUTY_DOCTOR'
    })
  );
  if (!rows[0]?.obligation) {
    throw AppError.internal(
      'Late-critical recovery obligation was not recorded',
      'EXTERNAL_RECOVERY_CRITICAL_REVIEW_REQUIRED'
    );
  }
  return rows[0].obligation;
}

export async function acknowledgeExternalRecoveryCriticalReviewForInboxTask(
  taskId,
  {
    tenantId,
    actorUid,
    actorRoles = [],
    actorPrimaryRole = null,
    actorRawRole = null,
    breakGlassId = null,
    requestId = null
  } = {}
) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(
    tid,
    async tx => {
      const bindings = await tx.$queryRawUnsafe(
        `SELECT obligation.id::text AS obligation_id,
              obligation.task_id, obligation.interface_family,
              obligation.recovery_inbox_id::text,
              acknowledgement.id::text AS acknowledgement_id,
              acknowledgement.recorded_at::text AS awareness_acknowledged_at
         FROM external_recovery_critical_review_obligations AS obligation
         LEFT JOIN external_recovery_critical_review_acknowledgements AS acknowledgement
           ON acknowledgement.tenant_id = obligation.tenant_id
          AND acknowledgement.obligation_id = obligation.id
        WHERE obligation.tenant_id = $1::uuid
          AND obligation.task_id = $2::integer
        LIMIT 2
        FOR UPDATE OF obligation`,
        tid,
        Number(taskId)
      );
      if (bindings.length === 0) return Object.freeze({ handled: false });
      if (bindings.length !== 1) {
        throw AppError.conflict(
          'Late-critical recovery task has ambiguous awareness evidence',
          'EXTERNAL_RECOVERY_CRITICAL_REVIEW_BINDING_INVALID'
        );
      }
      const binding = bindings[0];
      const task = await acknowledgeTask({
        tenantId: tid,
        id: taskId,
        actorUid,
        actorRoles,
        actorPrimaryRole,
        actorRawRole,
        breakGlassId,
        tx
      });
      const acknowledgedAt = task.metadata?.acknowledged_at;
      const acknowledgedVia = task.metadata?.acknowledged_via;
      if (!acknowledgedAt || !acknowledgedVia) {
        throw AppError.internal(
          'Task acknowledgement receipt is incomplete',
          'EXTERNAL_RECOVERY_CRITICAL_REVIEW_TASK_ACK_REQUIRED'
        );
      }
      const acknowledgementIdentity = {
        contract: 'late-critical-continuity-awareness',
        contract_version: OBLIGATION_VERSION,
        tenant_id: tid,
        obligation_id: binding.obligation_id,
        task_id: Number(task.id),
        actor_uid: actorUid,
        authorization_mode: acknowledgedVia,
        task_acknowledged_at: acknowledgedAt
      };
      const acknowledgementId = deterministicUuid(
        `external-recovery-critical-ack:${hashCanonicalValue(acknowledgementIdentity)}`
      );
      const receipts = await tx.$queryRawUnsafe(
        `SELECT public.external_recovery_critical_review_acknowledge($1::jsonb) AS acknowledgement`,
        JSON.stringify({
          ...acknowledgementIdentity,
          id: acknowledgementId,
          actor_role: task.metadata?.acknowledged_role || actorPrimaryRole,
          request_id: requestId,
          receipt_hash: hashCanonicalValue(acknowledgementIdentity)
        })
      );
      const acknowledgement = receipts[0]?.acknowledgement;
      if (!acknowledgement) {
        throw AppError.internal(
          'Continuity-awareness acknowledgement was not recorded',
          'EXTERNAL_RECOVERY_CRITICAL_REVIEW_ACK_REQUIRED'
        );
      }
      return Object.freeze({
        handled: true,
        acknowledgement,
        task: {
          ...task,
          external_recovery_critical_review_obligation_id: binding.obligation_id,
          external_recovery_critical_review_acknowledgement_id: acknowledgement.id,
          external_recovery_awareness_acknowledgement_required: false,
          external_recovery_awareness_acknowledged_at: acknowledgement.recorded_at
        }
      });
    },
    { isolationLevel: 'Serializable' }
  );
}

export default Object.freeze({
  acknowledgeExternalRecoveryCriticalReviewForInboxTask,
  appendExternalRecoveryCriticalReviewObligationTx
});
