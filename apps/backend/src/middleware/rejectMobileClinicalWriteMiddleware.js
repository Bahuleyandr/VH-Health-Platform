// src/middleware/rejectMobileClinicalWriteMiddleware.js
//
// Phone-mode Staff app is allowed to read authorised charts, message, report,
// and mark attendance. Clinical documentation and workflow writes remain
// desktop/tablet Staff app only.

import logger from '../logging/logger.js';
import { recordClinicalAuditEvent } from '../services/clinical/canonicalClinicalPlatformService.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

function deviceTypeOf(req) {
  return String(req.user?.deviceType ?? '').trim().toLowerCase();
}

function tenantOf(req) {
  return req.tenantId || req.user?.tenant_id || req.user?.tenantId || DEFAULT_TENANT_ID;
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

export function rejectMobileClinicalWrite(req, res, next) {
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

export default rejectMobileClinicalWrite;
