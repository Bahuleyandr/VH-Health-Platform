// src/routes/clinical/birthNotificationRoutes.js — G4 (reaudit 2026-08-25)
//
// Birth notification / birth-certificate register (CRS Form 1). Mirrors
// deathCertificationRoutes. Dark-gated in the service layer
// (requireBirthNotificationEnabled): env off → 503 BIRTH_NOTIFICATION_NOT_ENABLED,
// tenant off → 403 BIRTH_NOTIFICATION_DISABLED.

import { Router } from 'express';
import * as svc from '../../services/clinical/birthNotificationService.js';
import { success, relayAppError, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { markRouterDomain } from '../../config/openapiDomain.js';
import prisma from '../../lib/prisma.js';
import { patientAccessGuard } from '../../middleware/phiAccessMiddleware.js';

const router = markRouterDomain(Router(), 'birth-notification');

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      return relayAppError(res, err, 'Birth notification error');
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// PATIENT-ACCESS GUARDS LIVE HERE, NOT ON THE MOUNT.
//
// app.js used to wrap this router in patientAccessGuard('BIRTH_NOTIFICATION').
// A mount-level guard runs BEFORE Express has matched the route, so
// req.params is empty; every route here is keyed on a notification :id and
// none carries a patient identifier in the query, so resolvePatientForAccess
// found no patient and authorizePatientAccessRequest returned
// `no_patient_context` without evaluating a policy at all. It was a control
// that could never decide — in shadow OR enforce.
//
// The subject of this register is the MOTHER (birth_notifications
// .mother_patient_uid, NOT NULL). Each selector below resolves exactly the
// row the handler is about to serve, tenant-scoped, so the decision, the
// audit row and the disclosure are the same patient by construction.
const guardByNotificationId = patientAccessGuard('BIRTH_NOTIFICATION', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  patientSelector: async (req) => {
    const id = Number.parseInt(req.params?.id, 10);
    if (!Number.isInteger(id) || id <= 0) return null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT mother_patient_uid
         FROM birth_notifications
        WHERE id = $1::int AND tenant_id = $2::uuid
        LIMIT 1`,
      id,
      tenantOf(req),
    );
    const uid = Array.isArray(rows) ? rows[0]?.mother_patient_uid : null;
    return uid ? { uid } : null;
  },
});

// Create resolves the same subject the service will: an explicit
// mother_patient_uid when supplied, otherwise the mother behind the newborn
// the body names (the join createBirthNotification itself uses).
const guardByCreateBody = patientAccessGuard('BIRTH_NOTIFICATION', {
  careTeamModeGoverned: true,
  requirePatientContext: true,
  patientSelector: async (req) => {
    const explicit = typeof req.body?.mother_patient_uid === 'string'
      ? req.body.mother_patient_uid.trim()
      : '';
    if (explicit) return { uid: explicit };
    const newbornId = Number.parseInt(req.body?.newborn_id, 10);
    if (!Number.isInteger(newbornId) || newbornId <= 0) return null;
    const rows = await prisma.$queryRawUnsafe(
      `SELECT p.patient_uid AS mother_patient_uid
         FROM maternity_newborns n
         JOIN maternity_deliveries d
           ON d.id = n.delivery_id AND d.tenant_id = n.tenant_id
         JOIN maternity_pregnancies p
           ON p.id = d.pregnancy_id AND p.tenant_id = d.tenant_id
        WHERE n.id = $1::int AND n.tenant_id = $2::uuid
        LIMIT 1`,
      newbornId,
      tenantOf(req),
    );
    const uid = Array.isArray(rows) ? rows[0]?.mother_patient_uid : null;
    return uid ? { uid } : null;
  },
});

router.post('/notifications', requireStaffOrAdmin, guardByCreateBody, wrap(async (req) =>
  svc.createBirthNotification({
    ...req.body,
    tenantId: tenantOf(req),
    created_by: req.user?.uid,
    actor_role: req.user?.role,
  })));

router.get('/notifications', requireStaffOrAdmin, wrap(async (req) =>
  svc.listBirthNotifications({
    tenantId: tenantOf(req),
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    overdue: req.query.overdue,
    limit: req.query.limit,
  })));

router.get('/notifications/overdue', requireStaffOrAdmin, wrap(async (req) =>
  svc.overdueRegister({ tenantId: tenantOf(req), limit: req.query.limit })));

router.get('/notifications/:id', requireStaffOrAdmin, guardByNotificationId, wrap(async (req) =>
  svc.getBirthNotification({ tenantId: tenantOf(req), id: req.params.id })));

router.get('/notifications/:id/form1', requireStaffOrAdmin, guardByNotificationId, wrap(async (req) =>
  svc.printForm1({ tenantId: tenantOf(req), id: req.params.id })));

router.post('/notifications/:id/transition', requireStaffOrAdmin, guardByNotificationId, wrap(async (req) =>
  svc.transition({
    ...req.body,
    tenantId: tenantOf(req),
    id: req.params.id,
    certified_by: req.body.certified_by || req.user?.uid,
    actor_role: req.user?.role,
  })));

export default router;
