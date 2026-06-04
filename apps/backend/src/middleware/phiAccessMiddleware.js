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

import logger from '../logging/logger.js';
import {
  authorizePatientAccessRequest,
  patientAccessErrorPayload,
  resolvePatientForResourceAccess,
  shouldSkipAccessCheckError,
} from '../services/security/accessDecisionService.js';
import { policyCodeForRecordType } from '../services/security/accessPolicyRegistry.js';
import { DEFAULT_TENANT_ID } from '../services/tenant/tenantService.js';
import { logPhiAccess } from '../utils/hipaaAudit.js';

/**
 * Derive the patient ID from the request (params, query, or body).
 */
function derivePatientId(req) {
  return req.phiContext?.patientId
    || req.phiContext?.patient_id
    || req.phiContext?.patientUid
    || req.phiContext?.patient_uid
    || req.params?.patientId
    || req.params?.patient_uid
    || req.params?.patientUid
    || req.params?.uid
    || req.query?.patient_uid
    || req.query?.patientUid
    || req.query?.patientId
    || req.query?.patient_id
    || req.query?.phone   // phone can identify a patient
    || req.query?.patient_phone
    || req.query?.patientPhone
    || req.body?.patient_uid
    || req.body?.patientUid
    || req.body?.patientId
    || req.body?.patient_id
    || req.body?.phone
    || req.body?.patient_phone
    || req.body?.patientPhone
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

function deriveTenantId(req) {
  return req.tenantId
    || req.user?.tenant_id
    || req.user?.tenantId
    || req.tenant?.id
    || DEFAULT_TENANT_ID;
}

export function patientAccessGuard(recordType = 'PHI', options = {}) {
  return async function patientAccessGuardMiddleware(req, res, next) {
    try {
      const decision = await authorizePatientAccessRequest(req, {
        policyCode: options.policyCode || policyCodeForRecordType(recordType),
        recordType,
      });
      if (decision?.no_patient_context) return next();

      if (!decision.allowed) {
        return res.status(403).json(patientAccessErrorPayload(decision));
      }

      return next();
    } catch (err) {
      if (shouldSkipAccessCheckError(err)) {
        logger.warn('Patient access guard skipped because governance tables are not migrated', {
          path: req.originalUrl || req.url,
        });
        return next();
      }
      logger.error('Patient access guard failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Patient access check failed',
        code: 'PATIENT_ACCESS_CHECK_FAILED',
      });
    }
  };
}

export function patientAccessGuardForResource(recordType = 'PHI', options = {}) {
  const {
    policyCode,
    resourceType,
    idParam = 'id',
    idSelector = null,
    allowNoPatientResource = false,
  } = options;

  return async function patientAccessGuardForResourceMiddleware(req, res, next) {
    try {
      const resourceId = typeof idSelector === 'function'
        ? idSelector(req)
        : req.params?.[idParam] ?? req.query?.[idParam] ?? req.body?.[idParam] ?? null;

      if (!resourceId) {
        return patientAccessGuard(recordType, { policyCode })(req, res, next);
      }

      const patient = await resolvePatientForResourceAccess(req, {
        resourceType,
        resourceId,
      });

      if (!patient?.uid && allowNoPatientResource) return next();

      const decision = await authorizePatientAccessRequest(req, {
        policyCode: policyCode || policyCodeForRecordType(recordType),
        recordType,
        patient,
        requireResolvedPatient: true,
      });

      if (!decision.allowed) {
        return res.status(403).json(patientAccessErrorPayload(decision));
      }

      return next();
    } catch (err) {
      if (shouldSkipAccessCheckError(err)) {
        logger.warn('Patient resource access guard skipped because governance tables are not migrated', {
          path: req.originalUrl || req.url,
          resourceType,
        });
        return next();
      }
      logger.error('Patient resource access guard failed:', err);
      return res.status(500).json({
        success: false,
        message: 'Patient access check failed',
        code: 'PATIENT_ACCESS_CHECK_FAILED',
      });
    }
  };
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
  const middleware = function phiAccessLoggerMiddleware(req, res, next) {
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
        tenantId: deriveTenantId(req),
      });
    });

    next();
  };
  middleware.phiRecordType = recordType;
  return middleware;
}
