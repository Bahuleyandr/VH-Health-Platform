import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { resolvePathwayModeTx } from '../pathways/pathwayRuntimePersistence.js';
import { requireTenantId } from '../tenant/tenantService.js';

function normalizeLimit(value) {
  return Math.max(1, Math.min(Number.parseInt(value, 10) || 50, 100));
}

function normalizeId(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw AppError.notFound('Referral not found');
  return parsed;
}

async function referralModeActive(tx, tenantId) {
  return (await resolvePathwayModeTx({
    tx,
    tenantId,
    pathwayKey: CARE_PATHWAY_KEYS.REFERRAL,
  })) === PATHWAY_MODES.ACTIVE;
}

const PATIENT_REFERRAL_SELECT = `
  SELECT referral.id,
         referral.referral_number,
         referral.referred_to_department,
         referral.status,
         referral.closure_status,
         referral.closure_reason,
         referral.appointment_id,
         referral.created_at,
         referral.accepted_at,
         referral.completed_at,
         referral.closed_at,
         response.id AS response_id,
         response.version AS response_version,
         response.patient_summary,
         response.patient_instructions,
         response.follow_up_plan,
         response.signed_at,
         signature.id AS signature_id,
         signature.signature_method
    FROM referrals AS referral
    JOIN LATERAL (
      SELECT candidate.*
        FROM referral_responses AS candidate
       WHERE candidate.tenant_id = referral.tenant_id
         AND candidate.referral_id = referral.id
         AND candidate.release_to_patient = TRUE
       ORDER BY candidate.version DESC
       LIMIT 1
    ) AS response ON TRUE
    JOIN LATERAL (
      SELECT signed.id, signed.signature_method
        FROM clinical_document_signatures AS signed
       WHERE signed.tenant_id = response.tenant_id
         AND signed.document_type = 'referral_response'
         AND signed.document_id = response.id::text
       ORDER BY signed.signed_at DESC
       LIMIT 1
    ) AS signature ON TRUE`;

export async function listPatientReferrals({ tenantId, patientUid, limit = 50 } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    if (!await referralModeActive(tx, tid)) return [];
    return tx.$queryRawUnsafe(
      `${PATIENT_REFERRAL_SELECT}
        WHERE referral.tenant_id = $1::uuid
          AND referral.patient_uid = $2::uuid
        ORDER BY response.signed_at DESC, referral.id DESC
        LIMIT $3::integer`,
      tid,
      patientUid,
      normalizeLimit(limit),
    );
  });
}

export async function getPatientReferral({ tenantId, patientUid, id } = {}) {
  const tid = requireTenantId(tenantId);
  return setTenantTx(tid, async (tx) => {
    if (!await referralModeActive(tx, tid)) throw AppError.notFound('Referral not found');
    const rows = await tx.$queryRawUnsafe(
      `${PATIENT_REFERRAL_SELECT}
        WHERE referral.tenant_id = $1::uuid
          AND referral.patient_uid = $2::uuid
          AND referral.id = $3::integer
        LIMIT 1`,
      tid,
      patientUid,
      normalizeId(id),
    );
    if (!rows[0]) throw AppError.notFound('Referral not found');
    return rows[0];
  });
}

export default { listPatientReferrals, getPatientReferral };
