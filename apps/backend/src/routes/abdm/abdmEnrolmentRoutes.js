// src/routes/abdm/abdmEnrolmentRoutes.js
//
// ABHA enrolment routes (migration 701) — two mounts:
//   * portalRouter — patient self-enrolment under /api/v1/portal/abdm/enrolment
//     (identity from the JWT only; a patient can never enrol someone else).
//   * staffRouter  — front-desk assisted enrolment under /api/v1/abdm/enrolment
//     (patient registry write roles; patient_uid comes from the body).
//
// OTP-triggering endpoints (start / resend) carry the OTP rate-limit profile
// (3 per 10 minutes) — they fire real Aadhaar/mobile OTP SMS at the gateway.
//
// PRIVACY: aadhaar_number / otp are validated and RSA-encrypted in memory by
// the service and NEVER logged, persisted, or echoed. Do not add logging of
// req.body on these routes.

import { Router } from 'express';
import { markRouterDomain } from '../../config/openapiDomain.js';
import logger from '../../logging/logger.js';
import { otpRateLimiter } from '../../middleware/rateLimitMiddleware.js';
import { requireRole } from '../../middleware/rbacMiddleware.js';
import { PATIENT_REGISTRY_WRITE_ROLES } from '../../config/patientAccessRoles.js';
import {
  cancelEnrolment,
  getEnrolmentStatus,
  resendEnrolmentOtp,
  startEnrolment,
  verifyEnrolmentOtp,
} from '../../services/abdm/abhaEnrolmentService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

function handle(label, run) {
  return async (req, res, next) => {
    try {
      return await run(req, res);
    } catch (err) {
      if (err.isOperational) {
        return relayAppError(res, err, label);
      }
      logger.error(label, { error: err.message });
      return next(err);
    }
  };
}

function actorContext(req) {
  return {
    actorUid: req.user?.uid,
    actorRole: req.user?.role,
    requestId: req.id,
    ip: req.ip,
    userAgent: req.get?.('user-agent') || null,
  };
}

function logEnrolmentPhi(req, patientUid, action) {
  logPhiAccess({
    userId: req.user?.uid,
    userRole: req.user?.role,
    patientId: patientUid,
    recordType: 'abha_enrolment',
    action,
    ip: req.ip,
    requestId: req.id,
    tenantId: req.tenantId,
  });
}

function buildEnrolmentRoutes(router, resolveTargetUid) {
  router.post('/start', otpRateLimiter, handle('Failed to start ABHA enrolment', async (req, res) => {
    const patientUid = resolveTargetUid(req);
    if (!patientUid) return error(res, 'Patient UID is required', 400);
    const session = await startEnrolment({
      tenantId: req.tenantId,
      patientUid,
      flow: req.body?.flow || 'aadhaar_otp',
      aadhaarNumber: req.body?.aadhaar_number ?? req.body?.aadhaarNumber ?? null,
      mobile: req.body?.mobile ?? null,
      requestedBy: req.user?.uid,
    });
    logEnrolmentPhi(req, patientUid, 'CREATE');
    return success(res, { session }, 'Enrolment OTP requested', 201);
  }));

  router.post('/otp', handle('Failed to verify ABHA enrolment OTP', async (req, res) => {
    const sessionId = Number.parseInt(req.body?.session_id ?? req.body?.sessionId, 10);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return error(res, 'session_id is required', 400);
    }
    const session = await verifyEnrolmentOtp({
      tenantId: req.tenantId,
      sessionId,
      otp: req.body?.otp,
      ...actorContext(req),
    });
    // Enrolment completion binds a national health identifier — a PHI write.
    logEnrolmentPhi(req, session.patient_uid, 'UPDATE');
    return success(res, { session }, 'Enrolment OTP verified', 200);
  }));

  router.post('/resend', otpRateLimiter, handle('Failed to resend ABHA enrolment OTP', async (req, res) => {
    const sessionId = Number.parseInt(req.body?.session_id ?? req.body?.sessionId, 10);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return error(res, 'session_id is required', 400);
    }
    const session = await resendEnrolmentOtp({
      tenantId: req.tenantId,
      sessionId,
      aadhaarNumber: req.body?.aadhaar_number ?? req.body?.aadhaarNumber ?? null,
      mobile: req.body?.mobile ?? null,
    });
    return success(res, { session }, 'Enrolment OTP re-sent', 200);
  }));

  router.post('/cancel', handle('Failed to cancel ABHA enrolment', async (req, res) => {
    const sessionId = Number.parseInt(req.body?.session_id ?? req.body?.sessionId, 10);
    if (!Number.isFinite(sessionId) || sessionId <= 0) {
      return error(res, 'session_id is required', 400);
    }
    const session = await cancelEnrolment({ tenantId: req.tenantId, sessionId });
    return success(res, { session }, 'Enrolment cancelled', 200);
  }));

  return router;
}

// --- Patient portal (self only) --------------------------------------------

const portalRouter = Router();
markRouterDomain(portalRouter, 'abdm');
buildEnrolmentRoutes(portalRouter, (req) => req.user?.uid);

portalRouter.get('/status', handle('Failed to get ABHA enrolment status', async (req, res) => {
  const patientUid = req.user?.uid;
  if (!patientUid) return error(res, 'Authentication required', 401);
  const status = await getEnrolmentStatus({ tenantId: req.tenantId, patientUid });
  logEnrolmentPhi(req, patientUid, 'VIEW');
  return success(res, status, 'Enrolment status retrieved', 200);
}));

// --- Front-desk assisted ----------------------------------------------------

const staffRouter = Router();
markRouterDomain(staffRouter, 'abdm');
staffRouter.use(requireRole(...PATIENT_REGISTRY_WRITE_ROLES));
buildEnrolmentRoutes(staffRouter, (req) => req.body?.patient_uid ?? req.body?.patientUid);

staffRouter.get('/status/:patientUid', handle('Failed to get ABHA enrolment status', async (req, res) => {
  const status = await getEnrolmentStatus({
    tenantId: req.tenantId,
    patientUid: req.params.patientUid,
  });
  logEnrolmentPhi(req, req.params.patientUid, 'VIEW');
  return success(res, status, 'Enrolment status retrieved', 200);
}));

export { portalRouter as abdmEnrolmentPortalRouter, staffRouter as abdmEnrolmentStaffRouter };
