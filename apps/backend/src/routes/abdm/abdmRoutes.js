// src/routes/abdm/abdmRoutes.js
// ABDM (Ayushman Bharat Digital Mission) Routes
// Split into two routers:
//   - callbackRouter: public endpoints called by ABDM gateway (validated via request signature)
//   - patientRouter:  JWT-protected endpoints for patient consent management

import { Router } from 'express';
import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import logger from '../../logging/logger.js';
import abdmService from '../../services/abdm/abdmService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';

// ====================================
// CALLBACK ROUTER — Public (no JWT)
// Called by ABDM gateway; validated via request signature
// ====================================

const callbackRouter = Router();
const ABDM_CALLBACK_PATHS = new Set(['/consent/on-notify', '/health-info/on-request']);

/**
 * Middleware: Validate ABDM gateway request signature.
 * In production, verifies X-HIP-ID header and request timestamp.
 * Rejects requests that don't appear to come from the ABDM gateway.
 */
function validateABDMRequest(req, res, next) {
  if (!ABDM_CALLBACK_PATHS.has(req.path)) {
    return next('router');
  }

  if (!ABDM_CONFIG.enabled) {
    return error(res, 'ABDM integration is not enabled', 503);
  }

  // Verify timestamp is within acceptable window (5 minutes)
  const timestamp = req.headers['timestamp'] || req.body?.timestamp;
  if (timestamp) {
    const requestTime = new Date(timestamp).getTime();
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;
    if (Math.abs(now - requestTime) > fiveMinutes) {
      logger.warn('ABDM callback rejected: timestamp out of range', { timestamp });
      return error(res, 'Request timestamp out of acceptable range', 401);
    }
  }

  // Verify X-HIP-ID matches our HIP ID
  const hipId = req.headers['x-hip-id'];
  if (hipId && ABDM_CONFIG.hipId && hipId !== ABDM_CONFIG.hipId) {
    logger.warn('ABDM callback rejected: HIP ID mismatch', { received: hipId, expected: ABDM_CONFIG.hipId });
    return error(res, 'Invalid HIP ID', 401);
  }

  next();
}

callbackRouter.use(validateABDMRequest);

/**
 * POST /abdm/consent/on-notify
 * ABDM gateway notifies of a new consent request from a consent manager.
 */
callbackRouter.post('/consent/on-notify', async (req, res, next) => {
  try {
    const notification = req.body?.notification || req.body;

    if (!notification) {
      return error(res, 'Missing notification payload', 400);
    }

    const consentRequest = {
      consentRequestId: notification.consentRequestId || notification.consentId,
      purpose: notification.purpose?.code || notification.purpose,
      hiTypes: notification.hiTypes || notification.hi_types || [],
      patient: notification.patient || {},
      hiu: notification.hiu || {},
      requester: notification.requester || {},
      dateRange: notification.permission?.dateRange || notification.dateRange || {},
      expiry: notification.permission?.dataEraseAt || notification.expiry,
    };

    const consent = await abdmService.handleConsentRequest(consentRequest);

    return success(res, { consentId: consent.consent_id }, 'Consent request received', 202);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to handle ABDM consent notification', { error: err.message });
    next(err);
  }
});

/**
 * POST /abdm/health-info/on-request
 * ABDM gateway requests health data for a granted consent.
 */
callbackRouter.post('/health-info/on-request', async (req, res, next) => {
  try {
    const dataRequest = {
      transactionId: req.body?.transactionId,
      consentId: req.body?.hiRequest?.consent?.id || req.body?.consentId,
      hiTypes: req.body?.hiRequest?.hiTypes || req.body?.hiTypes || [],
      dateRange: req.body?.hiRequest?.dateRange || req.body?.dateRange || {},
      keyMaterial: req.body?.hiRequest?.keyMaterial || req.body?.keyMaterial || null,
      dataPushUrl: req.body?.hiRequest?.dataPushUrl || req.body?.dataPushUrl || null,
    };

    const result = await abdmService.handleDataRequest(dataRequest);

    return success(res, { transactionId: result.transaction_id }, 'Data request accepted', 202);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to handle ABDM data request', { error: err.message });
    next(err);
  }
});


// ====================================
// PATIENT ROUTER — JWT protected
// Patient-facing ABDM management endpoints
// ====================================

const patientRouter = Router();

function canViewAbdmAdmin(role) {
  return role === 'SUPER_ADMIN' || isStaff(role) || isAdmin(role);
}

/**
 * POST /abdm/register-abha
 * Link ABHA number to patient account (patient or admin).
 */
patientRouter.post('/register-abha', async (req, res, next) => {
  try {
    const { abha_number, abha_address, patient_uid } = req.body;

    // Patients can only register their own ABHA; admins can register for any patient
    let targetUid = req.user?.uid;
    if (patient_uid && (isAdmin(req.user?.role) || isStaff(req.user?.role))) {
      targetUid = patient_uid;
    }

    if (!targetUid) {
      return error(res, 'Patient UID is required', 400);
    }

    if (!abha_number) {
      return error(res, 'ABHA number is required', 400);
    }

    const result = await abdmService.registerABHA(targetUid, abha_number, abha_address);

    return success(res, result, 'ABHA linked to patient successfully', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to register ABHA', { error: err.message });
    next(err);
  }
});

/**
 * POST /abdm/verify-abha
 * Verify an ABHA number with the ABDM gateway.
 */
patientRouter.post('/verify-abha', async (req, res, next) => {
  try {
    const { abha_number } = req.body;

    if (!abha_number) {
      return error(res, 'ABHA number is required', 400);
    }

    if (!ABDM_CONFIG.enabled) {
      return error(res, 'ABDM integration is not enabled', 503);
    }

    const { default: abdmGateway } = await import('../../services/abdm/abdmGateway.js');
    const result = await abdmGateway.verifyABHA(abha_number);

    return success(res, result, 'ABHA verification result', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to verify ABHA', { error: err.message });
    next(err);
  }
});

/**
 * GET /abdm/patient-by-abha/:abhaNumber
 * Lookup patient by ABHA number (staff/admin only).
 */
patientRouter.get('/patient-by-abha/:abhaNumber', async (req, res, next) => {
  try {
    if (!canViewAbdmAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can lookup patients by ABHA', 403);
    }

    const { abhaNumber } = req.params;
    const patient = await abdmService.getPatientByABHA(abhaNumber);

    return success(res, patient, 'Patient found', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to lookup patient by ABHA', { error: err.message });
    next(err);
  }
});

/**
 * GET /abdm/status
 * Admin/staff integration overview for the admin dashboard.
 */
patientRouter.get('/status', async (req, res, next) => {
  try {
    if (!canViewAbdmAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can view ABDM status', 403);
    }

    const status = await abdmService.getAdminStatus();
    return success(res, status, 'ABDM status retrieved', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get ABDM status', { error: err.message });
    next(err);
  }
});

/**
 * GET /abdm/consent-requests
 * Admin/staff list of ABDM consent requests.
 */
patientRouter.get('/consent-requests', async (req, res, next) => {
  try {
    if (!canViewAbdmAdmin(req.user?.role)) {
      return error(res, 'Only staff or admin can view ABDM consent requests', 403);
    }

    const requests = await abdmService.listConsentRequests(req.query || {});
    return success(res, requests, 'ABDM consent requests retrieved', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to list ABDM consent requests', { error: err.message });
    next(err);
  }
});

/**
 * GET /abdm/consents
 * Get all ABDM consents for the authenticated patient.
 */
patientRouter.get('/consents', async (req, res, next) => {
  try {
    const patientUid = req.user?.uid;
    if (!patientUid) {
      return error(res, 'Authentication required', 401);
    }

    const consents = await abdmService.getPatientConsents(patientUid);

    return success(res, consents, 'ABDM consents retrieved', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to get ABDM consents', { error: err.message });
    next(err);
  }
});

/**
 * POST /abdm/consents/:id/grant
 * Grant an ABDM consent request.
 */
patientRouter.post('/consents/:id/grant', async (req, res, next) => {
  try {
    const { id } = req.params;
    const patientUid = req.user?.uid;

    if (!patientUid) {
      return error(res, 'Authentication required', 401);
    }

    const result = await abdmService.grantConsent(id, patientUid);

    return success(res, result, 'Consent granted successfully', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to grant ABDM consent', { error: err.message });
    next(err);
  }
});

/**
 * POST /abdm/consents/:id/deny
 * Deny an ABDM consent request.
 */
patientRouter.post('/consents/:id/deny', async (req, res, next) => {
  try {
    const { id } = req.params;
    const patientUid = req.user?.uid;
    const { reason } = req.body;

    if (!patientUid) {
      return error(res, 'Authentication required', 401);
    }

    const result = await abdmService.denyConsent(id, patientUid, reason);

    return success(res, result, 'Consent denied', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to deny ABDM consent', { error: err.message });
    next(err);
  }
});

/**
 * POST /abdm/consents/:id/revoke
 * Revoke a previously granted ABDM consent.
 */
patientRouter.post('/consents/:id/revoke', async (req, res, next) => {
  try {
    const { id } = req.params;
    const patientUid = req.user?.uid;

    if (!patientUid) {
      return error(res, 'Authentication required', 401);
    }

    const result = await abdmService.revokeConsent(id, patientUid);

    return success(res, result, 'Consent revoked successfully', 200);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode);
    }
    logger.error('Failed to revoke ABDM consent', { error: err.message });
    next(err);
  }
});

export { callbackRouter, patientRouter };
export default patientRouter;
