function referralIdFromInstance(instance) {
  if (instance?.source_episode_type !== 'referral') return null;
  const parsed = Number.parseInt(instance.source_episode_id, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loadReferralPathwayEvidence({ tx, tenantId, instance }) {
  const referralId = referralIdFromInstance(instance);
  if (!referralId) return { referral_found: false };
  const rows = await tx.$queryRawUnsafe(
    `SELECT referral.id,
            referral.status,
            referral.closure_status,
            referral.closure_reason,
            referral.current_owner_uid,
            referral.referring_doctor,
            referral.referred_to_doctor,
            referral.accepted_by,
            referral.ownership_accepted_at,
            response.id AS response_id,
            response.continuing_ownership,
            signature.id AS signature_id
       FROM referrals AS referral
       LEFT JOIN LATERAL (
         SELECT candidate.*
           FROM referral_responses AS candidate
          WHERE candidate.tenant_id = referral.tenant_id
            AND candidate.referral_id = referral.id
          ORDER BY candidate.version DESC
          LIMIT 1
       ) AS response ON TRUE
       LEFT JOIN LATERAL (
         SELECT signed.id
           FROM clinical_document_signatures AS signed
          WHERE signed.tenant_id = response.tenant_id
            AND signed.document_type = 'referral_response'
            AND signed.document_id = response.id::text
          ORDER BY signed.signed_at DESC
          LIMIT 1
       ) AS signature ON TRUE
      WHERE referral.tenant_id = $1::uuid
        AND referral.id = $2::integer
      LIMIT 1`,
    tenantId,
    referralId,
  );
  const row = rows[0];
  return row ? {
    referral_found: true,
    referral_id: Number(row.id),
    status: row.status,
    closure_status: row.closure_status,
    closure_reason: row.closure_reason,
    current_owner_uid: row.current_owner_uid,
    referring_doctor: row.referring_doctor,
    referred_to_doctor: row.referred_to_doctor,
    accepted_by: row.accepted_by,
    ownership_accepted_at: row.ownership_accepted_at,
    response_id: row.response_id,
    response_signed: Boolean(row.response_id && row.signature_id),
    continuing_ownership: row.continuing_ownership === true,
  } : { referral_found: false };
}

export const REFERRAL_PATHWAY_RUNTIME_HANDLERS = Object.freeze({
  receiverAcceptance: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'receiver_accepted', 'referral_closed']),
    loadEvidence: loadReferralPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      if (!loadedEvidence.referral_found) return { decision: 'blocked', evidence: loadedEvidence };
      if (loadedEvidence.closure_status === 'closed') {
        return { decision: 'referral_closed', evidence: loadedEvidence };
      }
      const accepted = ['accepted', 'in_progress', 'completed'].includes(loadedEvidence.status)
        && Boolean(loadedEvidence.accepted_by)
        && Boolean(loadedEvidence.ownership_accepted_at)
        && String(loadedEvidence.current_owner_uid || '')
          === String(loadedEvidence.accepted_by || '');
      return { decision: accepted ? 'receiver_accepted' : 'blocked', evidence: loadedEvidence };
    },
  }),
  signedResponse: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'response_signed', 'referral_closed']),
    loadEvidence: loadReferralPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      if (loadedEvidence.closure_status === 'closed') {
        return { decision: 'referral_closed', evidence: loadedEvidence };
      }
      return {
        decision: loadedEvidence.response_signed ? 'response_signed' : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  originatorClosure: Object.freeze({
    stepKinds: Object.freeze(['wait']),
    decisionCodes: Object.freeze(['blocked', 'referral_closed']),
    loadEvidence: loadReferralPathwayEvidence,
    async evaluate({ loadedEvidence }) {
      return {
        decision: loadedEvidence.response_signed && loadedEvidence.closure_status === 'closed'
          ? 'referral_closed'
          : 'blocked',
        evidence: loadedEvidence,
      };
    },
  }),
  finalize: Object.freeze({
    stepKinds: Object.freeze(['automation']),
    async execute({ instance }) {
      return {
        finalized: true,
        source_episode_type: instance.source_episode_type,
        source_episode_id: instance.source_episode_id,
      };
    },
  }),
});

export default REFERRAL_PATHWAY_RUNTIME_HANDLERS;
