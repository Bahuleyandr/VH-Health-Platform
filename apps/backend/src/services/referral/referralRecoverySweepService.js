import { setTenantTx } from '../../lib/prisma.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { createTask } from '../workflow/taskService.js';

function priorityForUrgency(value) {
  const urgency = String(value || '').trim().toLowerCase();
  if (urgency === 'emergency') return 'critical';
  if (urgency === 'urgent') return 'high';
  return 'normal';
}

export async function runReferralRecoverySweep({ tenantId, limit = 200 } = {}) {
  const tid = requireTenantId(tenantId);
  const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 200, 500));
  return setTenantTx(tid, async (tx) => {
    const mode = await resolvePathwayModeTx({
      tx,
      tenantId: tid,
      pathwayKey: CARE_PATHWAY_KEYS.REFERRAL,
    });
    if (mode !== PATHWAY_MODES.ACTIVE) {
      return Object.freeze({ mode, candidates: 0, materialized: 0, already_open: 0 });
    }
    const candidates = await tx.$queryRawUnsafe(
      `SELECT referral.*,
              appointment.status AS appointment_status,
              (referral.expires_at IS NOT NULL AND referral.expires_at <= NOW()) AS expired,
              (UPPER(COALESCE(appointment.status, '')) IN ('MISSED', 'NO_SHOW')) AS no_show
         FROM referrals AS referral
         LEFT JOIN appointments AS appointment
           ON appointment.tenant_id = referral.tenant_id
          AND appointment.id = referral.appointment_id
        WHERE referral.tenant_id = $1::uuid
          AND referral.request_fingerprint IS NOT NULL
          AND referral.closure_status = 'open'
          AND (
            (referral.expires_at IS NOT NULL AND referral.expires_at <= NOW())
            OR UPPER(COALESCE(appointment.status, '')) IN ('MISSED', 'NO_SHOW')
          )
        ORDER BY COALESCE(referral.expires_at, referral.created_at), referral.id
        LIMIT $2::integer
        FOR UPDATE OF referral SKIP LOCKED`,
      tid,
      boundedLimit,
    );
    let materialized = 0;
    let alreadyOpen = 0;
    for (const referral of candidates) {
      const reasons = [
        ...(referral.expired ? ['expiry_review'] : []),
        ...(referral.no_show ? ['appointment_no_show'] : []),
      ];
      const task = await createTask({
        tenantId: tid,
        tx,
        taskKind: 'follow_up',
        title: `Recover referral ${referral.referral_number}`,
        description: 'Review the expired or missed follow-up and record the next safe action.',
        patientUid: referral.patient_uid,
        relatedResourceType: 'referral_recovery',
        relatedResourceId: String(referral.id),
        priority: priorityForUrgency(referral.urgency),
        assignedToUid: referral.current_owner_uid || referral.referring_doctor,
        metadata: {
          referral_stage: 'recovery',
          referral_number: referral.referral_number,
          recovery_reasons: reasons,
          appointment_id: referral.appointment_id || null,
          appointment_status: referral.appointment_status || null,
          expires_at: referral.expires_at || null,
        },
        onConflictResourceDoNothing: true,
      });
      if (task) materialized += 1;
      else alreadyOpen += 1;
    }
    return Object.freeze({ mode, candidates: candidates.length, materialized, already_open: alreadyOpen });
  });
}

export default { runReferralRecoverySweep };
