import { AppError } from '../../utils/AppError.js';
import { CARE_PATHWAY_KEYS } from '../pathways/pathwayMode.js';

const ACTIVE_ADMISSION_STATUSES = new Set(['admitted', 'transferred']);
const GUARDED_OWNER_TRANSFER_OUTCOMES = new Set(['requested', 'accepted']);

export async function assertInpatientPendingResultOwnerTransferAllowedTx({
  tx,
  tenantId,
  pathwayInstance,
  outcome,
} = {}) {
  if (
    !GUARDED_OWNER_TRANSFER_OUTCOMES.has(outcome)
    || pathwayInstance?.pathway_key !== CARE_PATHWAY_KEYS.INPATIENT
  ) {
    return Object.freeze({ applicable: false });
  }
  if (
    pathwayInstance.source_episode_type !== 'admission'
    || !/^[1-9]\d*$/.test(String(pathwayInstance.source_episode_id || ''))
    || !pathwayInstance.patient_uid
  ) {
    throw AppError.conflict(
      'Inpatient ownership transfer lacks an exact admission binding',
      'INPATIENT_OWNER_TRANSFER_BINDING_INVALID',
    );
  }
  const admissionId = Number(pathwayInstance.source_episode_id);
  const rows = await tx.$queryRawUnsafe(
    `SELECT admission.status,
            EXISTS (
              SELECT 1
                FROM discharge_pending_result_handoffs AS handoff
               WHERE handoff.tenant_id = admission.tenant_id
                 AND handoff.admission_id = admission.id
                 AND handoff.patient_uid = admission.patient_uid
                 AND handoff.handoff_state IN ('pending', 'result_available')
            ) AS has_live_pending_result_ownership
       FROM admissions AS admission
      WHERE admission.tenant_id = $1::uuid
        AND admission.id = $2::integer
        AND admission.patient_uid = $3::uuid
      LIMIT 1
      FOR SHARE OF admission`,
    tenantId,
    admissionId,
    pathwayInstance.patient_uid,
  );
  const admission = rows[0];
  if (!admission) {
    throw AppError.conflict(
      'Inpatient ownership transfer admission binding no longer exists',
      'INPATIENT_OWNER_TRANSFER_BINDING_INVALID',
    );
  }
  const hasLiveOwnership = admission.has_live_pending_result_ownership === true;
  if (
    hasLiveOwnership
    && !ACTIVE_ADMISSION_STATUSES.has(String(admission.status || ''))
  ) {
    throw AppError.conflict(
      'Outstanding post-discharge result ownership cannot use the generic pathway transfer',
      'INPATIENT_POST_DISCHARGE_OWNER_TRANSFER_UNSUPPORTED',
    );
  }
  return Object.freeze({
    applicable: true,
    admission_status: admission.status,
    has_live_pending_result_ownership: hasLiveOwnership,
  });
}

export default {
  assertInpatientPendingResultOwnerTransferAllowedTx,
};
