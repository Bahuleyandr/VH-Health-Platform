// src/middleware/rejectMobileClinicalWriteMiddleware.js
//
// Phone-mode Staff app is allowed to read authorised charts, message, report,
// and mark attendance. Clinical documentation and workflow writes remain
// desktop/tablet Staff app only.

import logger from '../logging/logger.js';
import { recordClinicalAuditEvent } from '../services/clinical/canonicalClinicalPlatformService.js';
import { requireTenantId } from '../services/tenant/tenantService.js';
import { isStaff } from '../utils/roleHelpers.js';

function deviceTypeOf(req) {
  return String(req.user?.deviceType ?? '').trim().toLowerCase();
}

function tenantOf(req) {
  return requireTenantId(req.tenantId || req.user?.tenant_id || req.user?.tenantId);
}

function patientUidFromRequest(req) {
  return (
    req.body?.patient_uid ||
    req.body?.patientUid ||
    req.params?.patientUid ||
    req.params?.uid ||
    req.query?.patient_uid ||
    req.query?.patientUid ||
    null
  );
}

function auditDeniedAttempt(req, reason) {
  return recordClinicalAuditEvent({
    tenantId: tenantOf(req),
    patientUid: patientUidFromRequest(req),
    action: 'mobile_clinical_write.denied',
    actionStatus: 'denied',
    actorUid: req.user?.uid || null,
    actorRole: req.user?.role || null,
    resourceType: 'clinical_write_route',
    resourceTable: 'http_request',
    resourceId: `${req.method} ${req.originalUrl || req.path}`,
    requestId: req.id || null,
    ipAddress: req.ip || null,
    userAgent: req.get?.('user-agent') || null,
    metadata: {
      reason,
      device_type: req.user?.deviceType ?? null,
      path: req.originalUrl || req.path,
      method: req.method,
    },
    idempotencyKey: [
      'mobile-clinical-write-denied',
      req.id || Date.now(),
      req.user?.uid || 'unknown',
      req.method,
      req.originalUrl || req.path,
    ].join(':').slice(0, 220),
  }).catch((err) => {
    logger.warn('Failed to audit mobile clinical-write denial', {
      error: err?.message || String(err),
      path: req.originalUrl || req.path,
    });
  });
}

export function enforceStaffClinicalWriteDevicePosture(req, res, next) {
  const got = deviceTypeOf(req);

  if (!got) {
    logger.warn('Clinical write denied: missing deviceType claim', {
      user: req.user?.uid || 'unknown',
      path: req.originalUrl || req.path,
      method: req.method,
    });
    auditDeniedAttempt(req, 'DEVICE_TYPE_MISSING');
    return res.status(403).json({
      success: false,
      code: 'DEVICE_TYPE_MISSING',
      message: 'Please re-login before clinical entries can be saved.',
    });
  }

  if (got === 'mobile') {
    logger.warn('Clinical write denied from mobile Staff app', {
      user: req.user?.uid || 'unknown',
      path: req.originalUrl || req.path,
      method: req.method,
    });
    auditDeniedAttempt(req, 'CLINICAL_WRITE_DESKTOP_ONLY');
    return res.status(403).json({
      success: false,
      code: 'CLINICAL_WRITE_DESKTOP_ONLY',
      message: 'Clinical entries must be completed on Staff Desktop.',
      device_type: got,
    });
  }

  return next();
}

export function rejectMobileClinicalWrite(req, res, next) {
  // This is a Staff-app phone-mode policy ONLY (clinical writes are desktop/
  // tablet Staff app). It must not gate non-staff actors — e.g. a PATIENT
  // booking their own investigation from the mobile patient app, which is not a
  // staff clinical write. RBAC (wrapAutoRBAC/requireRole) remains the access
  // authority for who may reach each route; this guard only constrains the Staff
  // app's device posture. Without this exemption every mobile/patient-app write
  // 403s (DEVICE_TYPE_MISSING / CLINICAL_WRITE_DESKTOP_ONLY) — see finding
  // docs/qa-findings/2026-06-17-patient-investigation-booking-mobile-blocked.md.
  const role = req.user?.role;
  if (role && !isStaff(role)) {
    return next();
  }

  return enforceStaffClinicalWriteDevicePosture(req, res, next);
}

export default rejectMobileClinicalWrite;
