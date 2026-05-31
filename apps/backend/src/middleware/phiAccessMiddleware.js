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
    || req.query?.patient_id
    || req.query?.phone   // phone can identify a patient
    || req.body?.patient_uid
    || req.body?.patientId
    || req.body?.patient_id
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
 * Captures both actor and subject so the acting-as delegation flow is
 * fully traceable:
 *   * userId  / accessed_by — historically the actor (kept).
 *   * actorUid              — the human pressing the button (=
 *     req.acting.actorUid when delegating, = req.user.uid otherwise).
 *   * subjectUid            — the patient whose record was accessed (=
 *     req.user.uid AFTER any acting-as rewrite).
 *   * actingAsDependent     — TRUE iff X-Acting-As-Uid was honoured.
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
      const actorUid = req.acting?.actorUid ?? req.user?.uid ?? null;
      const subjectUid = req.user?.uid ?? null;
      const actingAsDependent = req.acting != null;

      // Use the actor (human pressing the button) for the legacy
      // accessed_by column — that preserves historical semantics, since
      // the column always meant "who initiated this access".
      const userId = actorUid || req.user?.id;

      // Skip if we can't identify who's accessing (middleware ran before auth)
      if (!userId) return;

      logPhiAccess({
        userId: String(userId),
        userRole: req.acting?.actorRole ?? req.user?.role ?? 'UNKNOWN',
        patientId: patientId ? String(patientId) : null,
        recordType,
        action: deriveAction(req.method),
        ip: req.ip,
        requestId: req.id,
        actorUid,
        subjectUid,
        actingAsDependent,
        deviceType: req.user?.deviceType ?? null,
      });
    });

    next();
  };
}
