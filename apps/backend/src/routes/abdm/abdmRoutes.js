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
import { ROLES, isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { verifySignedRequest, assertSharedReplayOnce } from '../../utils/signedRequest.js';
import { genericLimiter } from '../../middleware/rateLimitMiddleware.js';
import { resolveTenantBySender, getInteropSecret } from '../../services/interop/tenantInteropSecretService.js';
import { DEFAULT_TENANT_ID } from '../../services/tenant/tenantService.js';

// ====================================
// CALLBACK ROUTER — Public (no JWT)
// Called by ABDM gateway; validated via request signature
// ====================================

const callbackRouter = Router();
// Audit 2026-06-18: throttle the unauthenticated ABDM callback surface — each
// request does DB + HMAC work, so brute-force/DoS must be capped before that.
callbackRouter.use(genericLimiter);
const ABDM_CALLBACK_PATHS = new Set(['/consent/on-notify', '/health-info/on-request']);

/**
 * Middleware: Validate ABDM gateway request authenticity.
 * ABDM callbacks are public by mount, so enabled callbacks must be
 * self-authenticating: HIP id, timestamp, request id, HMAC signature,
 * and replay protection.
 *
 * Replay protection is two-layered, mirroring HL7 /receive:
 *   - verifySignedRequest: sync HMAC + freshness + same-PROCESS replay (Map).
 *   - assertSharedReplayOnce: cross-REPLICA replay guard (Redis SET NX EX → DB
 *     interop_replay_guard, fail-closed). The per-process Map is defeated by the
 *     3-replica cluster / a restart, so a captured (still-fresh) signed callback
 *     replayed against a different replica would otherwise be accepted again.
 */
async function validateABDMRequest(req, res, next) {
  if (!ABDM_CALLBACK_PATHS.has(req.path)) {
    return next('router');
  }

  if (!ABDM_CONFIG.enabled) {
    return error(res, 'ABDM integration is not enabled', 503);
  }

  const hipId = req.headers['x-hip-id'];
  if (!hipId) {
    logger.warn('ABDM callback rejected: missing HIP ID');
    return error(res, 'Invalid HIP ID', 401);
  }

  // W3: resolve the tenant from the HIP id BEFORE the HMAC check, then verify with
  // THAT tenant's secret — so one hospital's secret cannot authenticate a callback
  // aimed at another. A per-tenant row (tenant_interop_secrets) wins; the
  // configured global HIP id is the env-backed DEFAULT tenant (single-tenant
  // unchanged). An unrecognized HIP id is rejected — no blanket global fallback.
  let tenantId = await resolveTenantBySender('abdm_callback', hipId);
  let callbackSecret = tenantId ? await getInteropSecret(tenantId, 'abdm_callback') : null;
  // CAN-007: a per-tenant callback secret authenticates a SPECIFIC tenant's HIP,
  // so a consent it later names must belong to that tenant (strict). The
  // shared-secret/default fallback is the legacy single-tenant path (not strict).
  let strictTenant = !!(tenantId && callbackSecret);
  if (!callbackSecret && ABDM_CONFIG.hipId && hipId === ABDM_CONFIG.hipId) {
    tenantId = DEFAULT_TENANT_ID;
    callbackSecret = ABDM_CONFIG.callbackSecret;
    strictTenant = false;
  }
  if (!tenantId || !callbackSecret) {
    logger.warn('ABDM callback rejected: unrecognized HIP ID', { received: hipId });
    return error(res, 'Invalid HIP ID', 401);
  }

  // Resolve the signed-request fields once so the same identity feeds BOTH the
  // sync HMAC check and the cross-replica replay claim.
  const signature = req.headers['x-abdm-signature'] || req.headers['x-vhhealth-abdm-signature'];
  const timestamp = req.headers.timestamp || req.headers.TIMESTAMP || req.body?.timestamp;
  const requestId = req.headers['request-id'] || req.headers['x-request-id'] || req.body?.requestId || req.body?.request_id;

  try {
    // Sync fast-path: HMAC + freshness + same-process replay.
    verifySignedRequest({
      secret: callbackSecret,
      signature,
      timestamp,
      requestId,
      payload: req.body || {},
      context: 'ABDM callback',
      codePrefix: 'ABDM_CALLBACK',
      replayNamespace: 'abdm-callback',
    });
    // Cross-replica replay guard (the per-process Map above is defeated by the
    // multi-worker / multi-replica cluster). Fail-closed like HL7: a detected
    // replay OR an unreachable store rejects the request.
    await assertSharedReplayOnce({
      replayNamespace: 'abdm-callback',
      requestId,
      timestamp,
      signature,
      context: 'ABDM callback',
      codePrefix: 'ABDM_CALLBACK',
    });
  } catch (err) {
    logger.warn('ABDM callback rejected: authenticity check failed', {
      code: err.code,
      error: err.message,
    });
    return error(res, err.message, err.statusCode || 401);
  }

  // Hand the resolved tenant to the downstream handler (it still re-derives the
  // tenant from the matched patient/consent for the write, but this records the
  // callback's authenticated tenant).
  req.tenantId = tenantId;
  req.abdmStrictTenant = strictTenant; // CAN-007: enforce consent-tenant match on the per-tenant-secret path
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
      hip: notification.hip || {},
      hiu: notification.hiu || {},
      consentManager:
        notification.consentManager
        || notification.consent?.consentManager
        || {},
      authenticatedHipId: req.headers['x-hip-id'] || null,
      authenticatedConsentManagerId: req.headers['x-cm-id'] || null,
      requester: notification.requester || {},
      dateRange: notification.permission?.dateRange || notification.dateRange || {},
      expiry: notification.permission?.dataEraseAt || notification.expiry,
      // Thread the CM-signed consent artefact + its detached signature so
      // handleConsentRequest -> _verifyConsentArtefact can verify the CM RSA
      // signature (audit C-4b). Without these the verifier always saw undefined
      // and, once ABDM_VERIFY_CONSENT_ARTEFACT is enabled, rejected EVERY consent
      // as ABDM_CONSENT_UNSIGNED. Field names cover the common ABDM shapes (flat
      // consentDetail/consentArtefact and the nested consent.* form); confirm the
      // exact production gateway contract before flipping verification on.
      consentArtefact:
        notification.consentDetail
        || notification.consentArtefact
        || notification.consent?.consentDetail
        || notification.consent?.consentArtefact
        || null,
      signature:
        notification.signature
        || notification.consent?.signature
        || req.body?.signature
        || null,
    };

    const consent = await abdmService.handleConsentRequest(consentRequest, {
      callbackTenantId: req.tenantId,
      strict: req.abdmStrictTenant,
    });

    return success(res, { consentId: consent.consent_id }, 'Consent request received', 202);
  } catch (err) {
    if (err.isOperational) {
      return error(res, err.message, err.statusCode, {
        ...(err.details || {}),
        topLevel: { code: err.code },
      });
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

    const result = await abdmService.handleDataRequest(dataRequest, {
      callbackTenantId: req.tenantId,
      strict: req.abdmStrictTenant,
    });

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

function canManageAnyAbha(role) {
  return role === ROLES.ADMIN || role === 'SUPER_ADMIN';
}

/**
 * POST /abdm/register-abha
 * Link ABHA number to patient account (patient or admin).
 */
patientRouter.post('/register-abha', async (req, res, next) => {
  try {
    const { abha_number, abha_address, patient_uid } = req.body;

    const role = req.user?.role;
    let targetUid = req.user?.uid;
    if (patient_uid && canManageAnyAbha(role)) {
      targetUid = patient_uid;
    } else if (patient_uid && patient_uid !== req.user?.uid) {
      return error(res, 'You can only link ABHA for yourself', 403);
    }

    if (!targetUid) {
      return error(res, 'Patient UID is required', 400);
    }

    if (!abha_number) {
      return error(res, 'ABHA number is required', 400);
    }

    const result = await abdmService.registerABHA(targetUid, abha_number, abha_address, {
      tenantId: req.tenantId,
    });

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
    const patient = await abdmService.getPatientByABHA(abhaNumber, { tenantId: req.tenantId });

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

    const status = await abdmService.getAdminStatus({ tenantId: req.tenantId });
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

    const requests = await abdmService.listConsentRequests({
      ...(req.query || {}),
      tenantId: req.tenantId,
    });
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
