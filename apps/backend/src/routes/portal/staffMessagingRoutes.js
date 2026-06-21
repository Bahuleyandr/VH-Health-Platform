// src/routes/portal/staffMessagingRoutes.js
//
// Sprint 10 — staff side of the patient↔staff secure messaging
// inbox. Mounted at /api/v1/staff-messaging/*.

import { Router } from 'express';
import logger from '../../logging/logger.js';
import * as portal from '../../services/portal/patientPortalService.js';
import { success, error } from '../../utils/responseHelper.js';
import { isAdmin, isStaff } from '../../utils/roleHelpers.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';

const router = Router();

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function isStaffMessagingManager(role) {
  return ['ADMIN', 'SUPER_ADMIN', 'CMO', 'MEDICAL_SUPERINTENDENT'].includes(
    String(role || '').trim().toUpperCase(),
  );
}

function wrap(handler) {
  return async (req, res, _next) => {
    try {
      const data = await handler(req, res);
      if (res.headersSent) return;
      return success(res, data);
    } catch (err) {
      if (err.statusCode) return error(res, err.message, err.statusCode);
      logger.error('staff messaging route error:', err);
      return error(res, err.message || 'Messaging error', 500);
    }
  };
}

function requireStaffOrAdmin(req, res, next) {
  if (!isStaff(req.user?.role) && !isAdmin(req.user?.role)) {
    return error(res, 'Staff or admin role required', 403);
  }
  next();
}

// ── Staff inbox ──────────────────────────────────────────────────────
router.get('/inbox', requireStaffOrAdmin, wrap(async (req) =>
  portal.listStaffInbox({
    tenantId: tenantOf(req),
    viewer_uid: req.user?.uid,
    can_view_all: isStaffMessagingManager(req.user?.role),
    status: req.query.status,
    priority: req.query.priority,
    assigned_staff_uid: req.query.assigned_staff_uid,
    limit: req.query.limit,
  }),
));

router.get('/threads/:threadId', requireStaffOrAdmin, wrap(async (req) =>
  portal.getThread({
    tenantId: tenantOf(req),
    thread_id: req.params.threadId,
    viewer_kind: 'staff',
    viewer_uid: req.user?.uid,
    can_view_all: isStaffMessagingManager(req.user?.role),
  }),
));

router.post('/threads/:threadId/reply', requireStaffOrAdmin, wrap(async (req) =>
  portal.appendMessage({
    tenantId: tenantOf(req),
    thread_id: req.params.threadId,
    sender_kind: 'staff',
    sender_uid: req.user?.uid,
    sender_name: req.user?.name,
    can_view_all: isStaffMessagingManager(req.user?.role),
    body: req.body.body,
    attachments: req.body.attachments,
  }),
));

router.post('/threads/:threadId/assign', requireStaffOrAdmin, wrap(async (req, res) => {
  if (!isStaffMessagingManager(req.user?.role)) return error(res, 'Messaging manager role required', 403);
  return portal.assignThread({
    tenantId: tenantOf(req),
    thread_id: req.params.threadId,
    assigned_staff_uid: req.body.assigned_staff_uid,
  });
}));

router.post('/threads/:threadId/status', requireStaffOrAdmin, wrap(async (req, res) => {
  if (!isStaffMessagingManager(req.user?.role)) return error(res, 'Messaging manager role required', 403);
  return portal.setThreadStatus({
    tenantId: tenantOf(req),
    thread_id: req.params.threadId,
    status: req.body.status,
    priority: req.body.priority,
  });
}));

router.post('/threads/:threadId/read', requireStaffOrAdmin, wrap(async (req) =>
  portal.markThreadRead({
    tenantId: tenantOf(req),
    thread_id: req.params.threadId,
    reader_kind: 'staff',
    reader_uid: req.user?.uid,
    can_view_all: isStaffMessagingManager(req.user?.role),
  }),
));

export default router;
