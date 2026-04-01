/**
 * HIPAA PHI Access Logging Middleware
 *
 * Automatically logs PHI (Protected Health Information) access for routes
 * that handle patient medical data. Applied at the route level to avoid
 * needing logPhiAccess() calls in every individual controller.
 *
 * Usage in app.js:
 *   app.use('/api/v1/records', phiAccessLogger('MEDICAL_RECORD'), recordRoutes);
 *   app.use('/api/v1/prescriptions', phiAccessLogger('PRESCRIPTION'), prescriptionRoutes);
 */

import { logPhiAccess } from '../utils/hipaaAudit.js';

/**
 * Derive the patient ID from the request (params, query, or body).
 */
function derivePatientId(req) {
  return req.params?.patientId
    || req.params?.patient_uid
    || req.params?.uid
    || req.query?.patient_uid
    || req.query?.patientId
    || req.query?.phone   // phone can identify a patient
    || req.body?.patient_uid
    || req.body?.patientId
    || req.body?.phone
    || null;
}

/**
 * Map HTTP method to HIPAA action.
 */
function deriveAction(method) {
  switch (method) {
    case 'GET': case 'HEAD': return 'VIEW';
    case 'POST': return 'CREATE';
    case 'PUT': case 'PATCH': return 'UPDATE';
    case 'DELETE': return 'DELETE';
    default: return 'ACCESS';
  }
}

/**
 * Create middleware that logs PHI access after the response is sent.
 * Fire-and-forget — never blocks the request.
 *
 * @param {string} recordType - PHI category: 'MEDICAL_RECORD', 'INVESTIGATION',
 *   'PRESCRIPTION', 'PHARMACY_ORDER', 'APPOINTMENT', 'ADMISSION', 'CLINICAL_NOTE',
 *   'VITAL_SIGN', 'DIAGNOSIS', 'CLINICAL_ORDER'
 * @returns {import('express').RequestHandler}
 */
export function phiAccessLogger(recordType) {
  return (req, res, next) => {
    // Log after response is sent (fire-and-forget)
    res.on('finish', () => {
      // Only log successful access (2xx/3xx), not auth failures or errors
      if (res.statusCode >= 400) return;

      const patientId = derivePatientId(req);
      const userId = req.user?.uid || req.user?.id;

      // Skip if we can't identify who's accessing (middleware ran before auth)
      if (!userId) return;

      logPhiAccess({
        userId: String(userId),
        userRole: req.user?.role || 'UNKNOWN',
        patientId: patientId ? String(patientId) : null,
        recordType,
        action: deriveAction(req.method),
        ip: req.ip,
        requestId: req.id,
      });
    });

    next();
  };
}
