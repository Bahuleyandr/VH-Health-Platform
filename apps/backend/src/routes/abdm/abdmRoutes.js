// src/routes/abdm/abdmRoutes.js
// ABDM (Ayushman Bharat Digital Mission) Routes
// Split into two routers:
//   - callbackRouter: public endpoints called by ABDM gateway (validated via request signature)
//   - patientRouter:  JWT-protected endpoints for patient consent management

import { Router } from 'express';
import { ABDM_CONFIG } from '../../config/abdmConfig.js';
import logger from '../../logging/logger.js';
import abdmService from '../../services/abdm/abdmService.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { ROLES, isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { verifySignedRequest, assertSharedReplayOnce } from '../../utils/signedRequest.js';
import { genericLimiter } from '../../middleware/rateLimitMiddleware.js';
import { resolveInteropCredentialSnapshot } from '../../services/interop/tenantInteropSecretService.js';
import { DEFAULT_TENANT_ID } from '../../services/tenant/tenantService.js';
import {
  markAuthenticatedAbdmCallback,
  recordAuthenticatedAbdmCallback,
} from '../../services/integrations/externalAbdmRecoveryService.js';

// ====================================
// CALLBACK ROUTER — Public (no JWT)
// Called by ABDM gateway; validated via request signature
// ====================================

const callbackRouter = Router();
// Audit 2026-06-18: throttle the unauthenticated ABDM callback surface — each
// request does DB + HMAC work, so brute-force/DoS must be capped before that.
callbackRouter.use(genericLimiter);
// Every path here must ALSO be present in the app.js raw-body capture list
// (captureJsonRawBody) — signature verification runs over the exact bytes.
// The first two are the I16-recovered paths (618 intake, receipt_source
// non-NULL); the newer Scan & Share + HIU paths record PLAIN 124-shape
// abdm_webhook_events rows (receipt_source NULL — 618's CHECK pins non-NULL
// receipt_source to the two I16 paths).
const ABDM_CALLBACK_PATHS = new Set([
  '/consent/on-notify',
  '/health-info/on-request',
  '/patients/profile/share',
  '/hiu/consent-requests/on-init',
  '/hiu/consents/notify',
  '/hiu/health-info/on-request',
  '/hiu/health-info/push',
]);
const ABDM_CALLBACK_ENVIRONMENT = process.env.ABDM_ENVIRONMENT === 'production'
  ? 'production'
  : 'sandbox';

/**
 * Middleware: Validate ABDM gateway request authenticity.
 * ABDM callbacks are public by mount, so enabled callbacks must be
 * self-authenticating: HIP id, timestamp, request id, HMAC signature,
 * and replay protection.
 *
 * Replay protection is two-layered, mirroring HL7 /receive:
 *   - verifySignedRequest: sync HMAC + freshness + same-PROCESS replay (Map).
 *   - assertSharedReplayOnce: durable cross-REPLICA DB replay guard, followed
 *     by a best-effort Redis marker. The per-process Map is defeated by the
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
  const credential = await resolveInteropCredentialSnapshot('abdm_callback', hipId);
  let tenantId = credential?.tenant_id ?? null;
  let callbackSecret = credential?.secret ?? null;
  // CAN-007: a per-tenant callback secret authenticates a SPECIFIC tenant's HIP,
  // so a consent it later names must belong to that tenant (strict). The
  // shared-secret/default fallback is the legacy single-tenant path (not strict).
  let strictTenant = !!credential;
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

  if (!req.abdmRawBody || !req.abdmRawBody.length) {
    logger.error('ABDM callback missing raw body capture — check the app.js captureJsonRawBody list');
    return error(res, 'Unable to verify message signature', 400, {
      topLevel: { code: 'ABDM_RAW_BODY_MISSING' },
    });
  }

  try {
    // Sync fast-path: HMAC + freshness + same-process replay.
    verifySignedRequest({
      secret: callbackSecret,
      signature,
      timestamp,
      requestId,
      payload: req.abdmRawBody,
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
    req.abdmAuthEvidence = Object.freeze({
      hipId: String(hipId),
      requestId: String(requestId),
      timestamp: String(timestamp),
      signature: String(signature),
      authenticatedAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('ABDM callback rejected: authenticity check failed', {
      code: err.code,
      error: err.message,
    });
    if (err.statusCode) return relayAppError(res, err, 'ABDM callback authenticity check failed');
    return error(res, err.message, 401);
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
  let receipt = null;
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

    const intake = await recordAuthenticatedAbdmCallback({
      tenantId: req.tenantId,
      callbackPath: req.path,
      body: req.body,
      rawBody: req.abdmRawBody,
      environment: ABDM_CALLBACK_ENVIRONMENT,
      auth: req.abdmAuthEvidence,
    });
    receipt = intake.event;
    if (intake.duplicate) {
      return success(
        res,
        { consentId: receipt.external_event_id, receiptId: receipt.id },
        'Consent request already received',
        202,
      );
    }

    const consent = await abdmService.handleConsentRequest(consentRequest, {
      callbackTenantId: req.tenantId,
      strict: req.abdmStrictTenant,
    });

    await markAuthenticatedAbdmCallback({
      tenantId: req.tenantId,
      eventId: receipt.id,
      status: 'processed',
    });

    return success(res, { consentId: consent.consent_id }, 'Consent request received', 202);
  } catch (err) {
    if (receipt?.id && receipt.status === 'pending') {
      await markAuthenticatedAbdmCallback({
        tenantId: req.tenantId,
        eventId: receipt.id,
        status: 'failed',
        failureReason: err.message,
      }).catch(markErr => logger.error('Failed to mark ABDM callback receipt failed', {
        receiptId: receipt.id,
        error: markErr.message,
      }));
    }
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to handle ABDM consent notification');
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
  let receipt = null;
  try {
    const dataRequest = {
      transactionId: req.body?.transactionId,
      consentId: req.body?.hiRequest?.consent?.id || req.body?.consentId,
      hiTypes: req.body?.hiRequest?.hiTypes || req.body?.hiTypes || [],
      dateRange: req.body?.hiRequest?.dateRange || req.body?.dateRange || {},
      keyMaterial: req.body?.hiRequest?.keyMaterial || req.body?.keyMaterial || null,
      dataPushUrl: req.body?.hiRequest?.dataPushUrl || req.body?.dataPushUrl || null,
    };

    const intake = await recordAuthenticatedAbdmCallback({
      tenantId: req.tenantId,
      callbackPath: req.path,
      body: req.body,
      rawBody: req.abdmRawBody,
      environment: ABDM_CALLBACK_ENVIRONMENT,
      auth: req.abdmAuthEvidence,
    });
    receipt = intake.event;
    if (intake.duplicate) {
      return success(
        res,
        { transactionId: receipt.external_event_id, receiptId: receipt.id },
        'Data request already received',
        202,
      );
    }

    const result = await abdmService.handleDataRequest(dataRequest, {
      callbackTenantId: req.tenantId,
      strict: req.abdmStrictTenant,
    });

    await markAuthenticatedAbdmCallback({
      tenantId: req.tenantId,
      eventId: receipt.id,
      status: 'processed',
      relatedDataRequestId: result.id,
    });

    return success(res, { transactionId: result.transaction_id }, 'Data request accepted', 202);
  } catch (err) {
    if (receipt?.id && receipt.status === 'pending') {
      await markAuthenticatedAbdmCallback({
        tenantId: req.tenantId,
        eventId: receipt.id,
        status: 'failed',
        failureReason: err.message,
      }).catch(markErr => logger.error('Failed to mark ABDM callback receipt failed', {
        receiptId: receipt.id,
        error: markErr.message,
      }));
    }
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to handle ABDM data request');
    }
    logger.error('Failed to handle ABDM data request', { error: err.message });
    next(err);
  }
});

// ---------------------------------------------------------------------------
// SCAN & SHARE + THIN-HIU CALLBACKS (migrations 702/703).
//
// Same authenticity chain as the two legacy paths (validateABDMRequest:
// x-hip-id tenant resolution → HMAC over exact raw bytes → durable
// cross-replica replay claim). Handlers lazy-import their services so suites
// exercising the legacy callbacks never load the new dependency graph, and
// every service write carries req.tenantId EXPLICITLY (pre-RLS mount).
// ---------------------------------------------------------------------------

function abdmCallbackHandler(label, run) {
  return async (req, res, next) => {
    try {
      const result = await run(req);
      return success(res, result.data, result.message, 202);
    } catch (err) {
      if (err.isOperational) {
        return relayAppError(res, err, label);
      }
      logger.error(label, { error: err.message });
      return next(err);
    }
  };
}

/**
 * POST /abdm/patients/profile/share
 * Scan & Share: the CM posts a patient-shared profile after the patient scans
 * a counter QR. Derives a front-desk work item; redeliveries 202 replay-safe.
 */
callbackRouter.post('/patients/profile/share', abdmCallbackHandler(
  'Failed to handle ABDM patient profile share',
  async (req) => {
    const { handlePatientProfileShareCallback } = await import('../../services/abdm/abdmShareIntakeService.js');
    const result = await handlePatientProfileShareCallback({
      tenantId: req.tenantId,
      environment: ABDM_CALLBACK_ENVIRONMENT,
      body: req.body || {},
    });
    return {
      data: {
        acknowledgement: { status: 'SUCCESS' },
        requestId: req.body?.requestId || null,
        tokenNumber: result.tokenNumber,
      },
      message: result.duplicate
        ? 'Patient profile share already received'
        : 'Patient profile share received',
    };
  },
));

/** POST /abdm/hiu/consent-requests/on-init — gateway ack of consent init. */
callbackRouter.post('/hiu/consent-requests/on-init', abdmCallbackHandler(
  'Failed to handle ABDM HIU consent on-init',
  async (req) => {
    const { handleHiuConsentOnInit } = await import('../../services/abdm/abdmHiuService.js');
    const result = await handleHiuConsentOnInit({
      tenantId: req.tenantId,
      environment: ABDM_CALLBACK_ENVIRONMENT,
      body: req.body || {},
    });
    return {
      data: { requestId: req.body?.requestId || null, duplicate: result.duplicate },
      message: result.duplicate ? 'Consent on-init already received' : 'Consent on-init received',
    };
  },
));

/** POST /abdm/hiu/consents/notify — CM consent grant/deny/revoke for the HIU. */
callbackRouter.post('/hiu/consents/notify', abdmCallbackHandler(
  'Failed to handle ABDM HIU consent notification',
  async (req) => {
    const { handleHiuConsentNotify } = await import('../../services/abdm/abdmHiuService.js');
    const result = await handleHiuConsentNotify({
      tenantId: req.tenantId,
      environment: ABDM_CALLBACK_ENVIRONMENT,
      body: req.body || {},
    });
    return {
      data: { requestId: req.body?.requestId || null, duplicate: result.duplicate },
      message: result.duplicate
        ? 'Consent notification already received'
        : 'Consent notification received',
    };
  },
));

/** POST /abdm/hiu/health-info/on-request — CM ack of our hi-request. */
callbackRouter.post('/hiu/health-info/on-request', abdmCallbackHandler(
  'Failed to handle ABDM HIU health-info on-request',
  async (req) => {
    const { handleHiuHealthInfoOnRequest } = await import('../../services/abdm/abdmHiuService.js');
    const result = await handleHiuHealthInfoOnRequest({
      tenantId: req.tenantId,
      environment: ABDM_CALLBACK_ENVIRONMENT,
      body: req.body || {},
    });
    return {
      data: { requestId: req.body?.requestId || null, duplicate: result.duplicate },
      message: result.duplicate ? 'Acknowledgement already received' : 'Acknowledgement received',
    };
  },
));

/**
 * POST /abdm/hiu/health-info/push — the dataPushUrl leg: the HIP pushes
 * encrypted FHIR entries; parts decrypt against the session's persisted
 * receive key, bundles land in R2, references in abdm_hiu_received_bundles.
 */
callbackRouter.post('/hiu/health-info/push', abdmCallbackHandler(
  'Failed to handle ABDM HIU data push',
  async (req) => {
    const { handleHiuDataPush } = await import('../../services/abdm/abdmHiuService.js');
    const result = await handleHiuDataPush({
      tenantId: req.tenantId,
      environment: ABDM_CALLBACK_ENVIRONMENT,
      body: req.body || {},
      rawBody: req.abdmRawBody,
      authenticatedHipId: req.abdmAuthEvidence?.hipId || null,
    });
    return {
      data: {
        transactionId: result.transactionId,
        duplicate: result.duplicate,
        stored: result.stored ?? 0,
        failed: result.failed ?? 0,
      },
      message: result.duplicate ? 'Data push page already received' : 'Data push received',
    };
  },
));


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
 * Link an ABHA the patient ALREADY HOLDS to their account (patient or admin).
 *
 * Body: `{ abha_number, abha_address? , patient_uid? }` — snake_case, matching
 * the rest of this router. This is a LINK, not an enrolment: creating a new
 * ABHA is an ABDM Aadhaar/mobile-OTP flow the platform does not implement (see
 * the note on `abdmService.registerABHA`), so the patient app collects an ABHA
 * the patient already has rather than demographics. The client previously
 * POSTed `{mobile,name,yearOfBirth,gender,email}` here — an enrolment payload
 * this endpoint has never accepted — and every call 400'd (audit follow-up
 * P13).
 *
 * Responds with the resulting `{linked, abhaNumber, abhaAddress}` linkage, the
 * same shape as `GET /abdm/my-abha`.
 */
patientRouter.post('/register-abha', async (req, res, next) => {
  try {
    const { abha_number, abha_address, patient_uid } = req.body || {};

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

    // Treat whitespace-only as absent — otherwise it reaches the service and
    // fails the format check with the less helpful "must be 14 digits".
    if (typeof abha_number !== 'string' || !abha_number.trim()) {
      return error(res, 'ABHA number is required', 400);
    }

    const linkage = await abdmService.registerABHA(targetUid, abha_number, abha_address, {
      tenantId: req.tenantId,
      actorUid: req.user?.uid,
      actorRole: role,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.get?.('user-agent') || null,
    });

    // Binding a national health identifier to a patient record is a PHI write.
    // Mirrors the logging on GET /abdm/my-abha.
    logPhiAccess({
      userId: req.user?.uid,
      userRole: role,
      patientId: targetUid,
      recordType: 'abha_linkage',
      action: 'UPDATE',
      ip: req.ip,
      requestId: req.id,
      tenantId: req.tenantId,
    });

    return success(res, linkage, 'ABHA linked to patient successfully', 200);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to register ABHA');
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
      return relayAppError(res, err, 'Failed to verify ABHA');
    }
    logger.error('Failed to verify ABHA', { error: err.message });
    next(err);
  }
});

/**
 * GET /abdm/my-abha
 * The calling patient's OWN ABHA linkage state.
 *
 * The patient app previously had no self-scoped way to ask this and fell back to
 * the staff/admin `/patient-by-abha/:abhaNumber` lookup below, which 403s for the
 * PATIENT role — so an already-linked patient was shown the registration form
 * (audit F12). Identity comes from the JWT only; there is no lookup parameter, so
 * this endpoint can never disclose another patient's linkage.
 *
 * Reads local linkage columns only — no ABDM gateway call — so it keeps working
 * while ABDM credentials are unset and the gateway routes 503.
 */
patientRouter.get('/my-abha', async (req, res, next) => {
  try {
    const patientUid = req.user?.uid;
    if (!patientUid) {
      return error(res, 'Authentication required', 401);
    }

    const linkage = await abdmService.getMyAbhaLinkage(patientUid, { tenantId: req.tenantId });

    logPhiAccess({
      userId: patientUid,
      userRole: req.user?.role,
      patientId: patientUid,
      recordType: 'abha_linkage',
      action: 'VIEW',
      ip: req.ip,
      requestId: req.id,
      tenantId: req.tenantId,
    });

    return success(res, linkage, 'ABHA linkage retrieved', 200);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to get ABHA linkage');
    }
    logger.error('Failed to get ABHA linkage', { error: err.message });
    next(err);
  }
});

/**
 * POST /abdm/my-abha/verify
 * Verify the ABHA number already linked (pending) on the account against the
 * ABDM gateway and promote it to 'verified' (migration 653).
 *
 * Auth mirrors POST /register-abha: the target defaults to the caller's own
 * uid; ADMIN/SUPER_ADMIN may pass `patient_uid` to verify on behalf of a
 * patient. Fail-closed: 503 while ABDM is disabled, like /verify-abha — a
 * pending link can only be promoted through a real gateway check.
 */
patientRouter.post('/my-abha/verify', async (req, res, next) => {
  try {
    const { patient_uid } = req.body || {};

    const role = req.user?.role;
    let targetUid = req.user?.uid;
    if (patient_uid && canManageAnyAbha(role)) {
      targetUid = patient_uid;
    } else if (patient_uid && patient_uid !== req.user?.uid) {
      return error(res, 'You can only verify ABHA for yourself', 403);
    }

    if (!targetUid) {
      return error(res, 'Patient UID is required', 400);
    }

    const linkage = await abdmService.verifyLinkedAbha(targetUid, {
      tenantId: req.tenantId,
      actorUid: req.user?.uid,
      actorRole: role,
      requestId: req.id,
      ip: req.ip,
      userAgent: req.get?.('user-agent') || null,
    });

    // Promoting a national health identifier binding is a PHI write; mirrors
    // the logging on POST /register-abha.
    logPhiAccess({
      userId: req.user?.uid,
      userRole: role,
      patientId: targetUid,
      recordType: 'abha_linkage',
      action: 'UPDATE',
      ip: req.ip,
      requestId: req.id,
      tenantId: req.tenantId,
    });

    return success(res, linkage, 'ABHA link verified', 200);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to verify linked ABHA');
    }
    logger.error('Failed to verify linked ABHA', { error: err.message });
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
    // Resolved by external ABHA number, not a params/body patient_uid — stash
    // it so the phiAccessLogger (which reads req.phiContext) attributes this
    // lookup to the found patient instead of logging patient_id: null.
    req.phiContext = { ...(req.phiContext || {}), patientUid: patient.uid };

    return success(res, patient, 'Patient found', 200);
  } catch (err) {
    if (err.isOperational) {
      return relayAppError(res, err, 'Failed to lookup patient by ABHA');
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
      return relayAppError(res, err, 'Failed to get ABDM status');
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
      return relayAppError(res, err, 'Failed to list ABDM consent requests');
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
      return relayAppError(res, err, 'Failed to get ABDM consents');
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
      return relayAppError(res, err, 'Failed to grant ABDM consent');
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
      return relayAppError(res, err, 'Failed to deny ABDM consent');
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
      return relayAppError(res, err, 'Failed to revoke ABDM consent');
    }
    logger.error('Failed to revoke ABDM consent', { error: err.message });
    next(err);
  }
});

export { callbackRouter, patientRouter };
export default patientRouter;
