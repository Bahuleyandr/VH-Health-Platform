import logger from '../../logging/logger.js';
import { ACCESS_POLICY_CODES } from '../../services/security/accessPolicyRegistry.js';
import { authorizePatientAccessRequest } from '../../services/security/accessDecisionService.js';
import { authorizeChannel, parsePatientChannel } from './channelAuth.js';

const PATIENT_CHANNEL_DENIAL = 'Patient channel access denied';

function patientAccessRequest(identity, topic) {
  const delegated = identity.revocationOwnerUid
    && String(identity.revocationOwnerUid).toLowerCase() !== String(identity.userId).toLowerCase();
  return {
    id: identity.jti || identity.accessSessionJti || null,
    method: 'GET',
    originalUrl: `/ws/patient/${topic}/subscribe`,
    params: {},
    query: {},
    body: {},
    tenantId: identity.tenantId,
    user: {
      uid: identity.userId,
      role: identity.role,
      rawRole: identity.role,
      tenant_id: identity.tenantId,
      tenantId: identity.tenantId,
    },
    ...(delegated ? {
      acting: {
        actorUid: identity.revocationOwnerUid,
        actorRole: 'PATIENT',
        actorRawRole: 'PATIENT',
        subjectUid: identity.userId,
      },
    } : {}),
  };
}

export async function authorizeSubscriptionChannel(channel, identity) {
  const patientChannel = parsePatientChannel(channel);
  if (!patientChannel) return authorizeChannel(channel, identity);
  if (!identity?.userId || !identity?.role || !identity?.tenantId) {
    return { allowed: false, reason: PATIENT_CHANNEL_DENIAL };
  }

  try {
    const decision = await authorizePatientAccessRequest(
      patientAccessRequest(identity, patientChannel.topic),
      {
        policyCode: ACCESS_POLICY_CODES.PATIENT_REALTIME_SUBSCRIBE,
        recordType: 'REALTIME_PATIENT_CHANNEL',
        patient: { uid: patientChannel.patientUid },
        audit: true,
        shadowMode: false,
        requireResolvedPatient: true,
      },
    );
    return decision.allowed
      ? { allowed: true }
      : { allowed: false, reason: PATIENT_CHANNEL_DENIAL };
  } catch (err) {
    logger.error('Patient realtime subscription authorization unavailable', {
      error: err?.message,
      tenantId: identity.tenantId,
      userId: identity.userId,
      topic: patientChannel.topic,
    });
    return { allowed: false, reason: PATIENT_CHANNEL_DENIAL };
  }
}
