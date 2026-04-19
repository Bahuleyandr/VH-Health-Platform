import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const toUuidOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return UUID_RE.test(normalized) ? normalized : null;
};

/**
 * Log HIPAA-required access to Protected Health Information (PHI).
 * Records who accessed what patient data, when, and from where.
 * Fire-and-forget — never blocks the request.
 */
export function logPhiAccess({ userId, userRole, patientId, recordType, action = 'VIEW', ip, requestId }) {
  setImmediate(async () => {
    try {
      const accessedBy = toUuidOrNull(userId);
      const patientUuid = toUuidOrNull(patientId);
      await prisma.$queryRawUnsafe(
        `INSERT INTO hipaa_access_log (accessed_by, accessed_by_role, patient_id, record_type, action, ip_address, request_id, accessed_at)
         VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, NOW())`,
        accessedBy, userRole, patientUuid, recordType, action, ip || null, requestId || null
      );
    } catch (err) {
      // Fallback to file log — HIPAA audit must never be lost
      logger.warn('HIPAA audit DB write failed, logging to file:', {
        accessed_by: userId,
        accessed_by_role: userRole,
        patient_id: patientId,
        record_type: recordType,
        action,
        timestamp: new Date().toISOString(),
        error: err.message
      });
    }
  });
}
