// src/middleware/consentMiddleware.js
// HIPAA Consent Verification Middleware
// Checks that a patient has granted the required consent type before allowing access.

import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { logPhiAccess } from '../utils/hipaaAudit.js';

/**
 * Factory middleware: requires active consent of a given type for the patient
 * whose data is being accessed.
 *
 * Patient UID is extracted from req.params.patientUid, req.params.patient_uid,
 * req.body.patient_uid, or req.query.patient_uid (in that priority order).
 *
 * @param {string} consentType - The consent type to check (e.g. 'data_access', 'treatment', 'research')
 * @returns {import('express').RequestHandler}
 */
export function requireConsent(consentType) {
  return async (req, res, next) => {
    try {
      const patientUid =
        req.params.patientUid ||
        req.params.patient_uid ||
        req.body?.patient_uid ||
        req.query?.patient_uid;

      if (!patientUid) {
        return res.status(400).json({
          success: false,
          message: 'Patient UID is required for consent verification',
        });
      }

      // Query for active consent (granted = true, not revoked)
      const result = await prisma.$queryRawUnsafe(
        `SELECT id, consent_type, granted, granted_at
         FROM patient_consents
         WHERE patient_uid = $1
           AND consent_type = $2
           AND granted = true
           AND revoked_at IS NULL
         ORDER BY granted_at DESC
         LIMIT 1`,
        [patientUid, consentType]
      );

      const userId = req.user?.uid || req.user?.id || null;
      const userRole = req.user?.role || null;
      const ip = req.ip || req.headers['x-forwarded-for'] || null;

      // Log the consent check in audit log (fire-and-forget)
      setImmediate(async () => {
        try {
          await prisma.$queryRawUnsafe(
            `INSERT INTO audit_log
              (user_id, user_name, user_role, ip_address, method, path, module, action,
               request_summary, status_code, success)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              userId,
              req.user?.name || null,
              userRole,
              ip,
              req.method,
              req.originalUrl?.split('?')[0] || req.path || '',
              'consent',
              'consent_check',
              JSON.stringify({ patient_uid: patientUid, consent_type: consentType, consent_found: result.rows.length > 0 }),
              result.rows.length > 0 ? 200 : 403,
              result.rows.length > 0,
            ]
          );
        } catch (auditErr) {
          logger.warn('Consent audit log write failed:', { error: auditErr.message });
        }
      });

      if (result.rows.length === 0) {
        // Also log as PHI access attempt (denied)
        logPhiAccess({
          userId,
          userRole,
          patientId: patientUid,
          recordType: `consent_check:${consentType}`,
          action: 'CONSENT_DENIED',
          ip,
          requestId: req.id,
        });

        return res.status(403).json({
          success: false,
          message: 'Patient consent required for this action',
        });
      }

      // Consent exists — attach to request for downstream use
      req.patientConsent = result[0];
      next();
    } catch (err) {
      logger.error('Consent middleware error:', { error: err.message });
      next(err);
    }
  };
}

export default requireConsent;
