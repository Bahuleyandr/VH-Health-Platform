import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { requireTenantId } from '../services/tenant/tenantService.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toUuidOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return UUID_RE.test(normalized) ? normalized : null;
};

// Durable, never-throwing file fallback for the HIPAA access log. The DB INSERT
// runs inside a detached setImmediate (fire-and-forget), so a throw out of the
// fallback would become an unhandled rejection and silently drop the audit.
// logger.warn lands in error.log/combined.log; if even that throws (transport /
// serialization failure) we degrade to console.error rather than losing the
// entry or crashing the deferred callback. HIPAA audit must never be lost.
function _logPhiAccessToFile(entry) {
  try {
    logger.warn('HIPAA audit DB write failed, logging to file:', entry);
  } catch (logErr) {
    try {
      console.error('HIPAA_AUDIT file fallback failed:', JSON.stringify(entry), logErr?.message);
    } catch {
      // Last resort exhausted; never throw out of the audit path.
    }
  }
}

/**
 * Log HIPAA-required access to Protected Health Information (PHI).
 * Records who accessed what patient data, when, and from where.
 * Fire-and-forget — never blocks the request.
 *
 * The optional `actorUid` / `subjectUid` / `actingAsDependent` triple
 * captures the acting-as delegation hop (X-Acting-As-Uid). Callers that
 * don't pass them fall back to the legacy semantic where
 * `accessed_by` IS the actor and there is no distinct subject.
 */
export function logPhiAccess({
  userId,
  userRole,
  patientId,
  recordType,
  action = 'VIEW',
  ip,
  requestId,
  actorUid,
  subjectUid,
  actingAsDependent,
  deviceType,
  tenantId,
}) {
  setImmediate(async () => {
    try {
      const accessedBy = toUuidOrNull(userId);
      const actorUidNorm = toUuidOrNull(actorUid) ?? accessedBy;
      const subjectUidNorm = toUuidOrNull(subjectUid);
      const tenantIdNorm = requireTenantId(toUuidOrNull(tenantId));
      const actingFlag = actingAsDependent === true;
      // patient_id stored as text — accept either uuid or int form
      // (callers across the app use both depending on which surface
      // raised the audit). Coerce non-empty values to string.
      const patientIdText = patientId == null || patientId === ''
        ? null
        : String(patientId);
      await prisma.$queryRawUnsafe(
        `INSERT INTO hipaa_access_log
           (accessed_by, accessed_by_role, patient_id, record_type, action,
            ip_address, request_id, accessed_at,
            actor_uid, subject_uid, acting_as_dependent, device_type, tenant_id)
         VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, NOW(), $8::uuid, $9::uuid, $10, $11, $12::uuid)`,
        accessedBy, userRole, patientIdText, recordType, action,
        ip || null, requestId || null,
        actorUidNorm, subjectUidNorm, actingFlag, deviceType || null, tenantIdNorm,
      );
    } catch (err) {
      // Fallback to file log — HIPAA audit must never be lost. Routed through a
      // defensive helper so a logger/transport failure inside this detached
      // setImmediate cannot escape as an unhandled rejection (which would
      // silently drop the audit).
      _logPhiAccessToFile({
        accessed_by: userId,
        accessed_by_role: userRole,
        patient_id: patientId,
        record_type: recordType,
        action,
        actor_uid: actorUid,
        subject_uid: subjectUid,
        acting_as_dependent: actingAsDependent === true,
        device_type: deviceType || null,
        tenant_id: tenantId || null,
        timestamp: new Date().toISOString(),
        error: err?.message
      });
    }
  });
}
