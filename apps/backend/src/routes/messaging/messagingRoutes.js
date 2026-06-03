// src/routes/messaging/messagingRoutes.js

import express from 'express';
import { validationResult } from 'express-validator';
import { sanitizeBody } from '../../middleware/sanitizeMiddleware.js';
import messagingService from '../../services/messaging/messagingService.js';
import { success, error } from '../../utils/responseHelper.js';
import { requiredString, paramId } from '../../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = express.Router();

// Sanitize message text fields
const sanitizeMessageFields = sanitizeBody('body', 'subject');
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

const tenantOf = req =>
  req.tenantId || req.user?.tenant_id || req.user?.tenantId || DEFAULT_TENANT_ID;

const normalizeRole = role =>
  String(role || '')
    .trim()
    .toUpperCase();

const requireAdminMessageLog = (req, res, next) => {
  const role = normalizeRole(req.user?.rawRole || req.user?.role);
  if (!['ADMIN', 'SUPER_ADMIN'].includes(role)) {
    return error(res, 'Admin or SuperAdmin role required', 403);
  }
  next();
};

const normalizeSendPayload = (req, _res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body.recipient_uid = req.body.recipient_uid || req.body.to_uid;
    req.body.body = req.body.body || req.body.content;
    if (typeof req.body.priority === 'string') {
      req.body.priority = req.body.priority.toLowerCase();
    }
  }
  next();
};

/**
 * POST /messaging/send
 * Send a message to another staff member.
 */
router.post(
  '/send',
  normalizeSendPayload,
  requiredString('recipient_uid'),
  requiredString('body', 2000),
  validate,
  sanitizeMessageFields,
  async (req, res, next) => {
    try {
      const senderUid = req.user?.uid;
      if (!senderUid) {
        return error(res, 'Authentication required', 401);
      }

      const { recipient_uid, body, priority, patient_uid, subject, thread_id, admission_id } =
        req.body;

      if (!recipient_uid || !body) {
        return error(res, 'recipient_uid and body are required', 400);
      }

      const message = await messagingService.sendMessage(
        senderUid,
        recipient_uid,
        body,
        priority || 'normal',
        patient_uid || null,
        subject || null,
        tenantOf(req),
        {
          threadId: thread_id || null,
          admissionId: admission_id || null
        }
      );

      return success(res, message, 'Message sent successfully', 201);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /messaging/broadcast
 * Send one persisted message row per recipient.
 * HR/Admin can target all staff, departments, or selected staff. Department
 * incharges can target their own department.
 */
router.post(
  '/broadcast',
  normalizeSendPayload,
  requiredString('body', 2000),
  validate,
  sanitizeMessageFields,
  async (req, res, next) => {
    try {
      const senderUid = req.user?.uid;
      if (!senderUid) {
        return error(res, 'Authentication required', 401);
      }

      const result = await messagingService.sendBroadcast({
        senderUid,
        tenantId: tenantOf(req),
        actorRole: req.user?.rawRole || req.user?.role,
        scope: req.body.scope,
        department: req.body.department,
        recipientUids: req.body.recipient_uids || req.body.recipientUids || [],
        body: req.body.body,
        priority: req.body.priority || 'normal',
        subject: req.body.subject || null,
        patientUid: req.body.patient_uid || null,
        admissionId: req.body.admission_id || null
      });

      return success(res, result, 'Message sent successfully', 201);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /messaging/targets
 * Staff target directory used by the compose surface.
 */
router.get('/targets', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const result = await messagingService.getTargets(
      staffUid,
      tenantOf(req),
      req.user?.rawRole || req.user?.role,
      req.query.search,
      req.query.limit
    );

    return success(res, result, 'Message targets retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /messaging/threads
 * First-class staff conversation thread list.
 */
router.get('/threads', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const result = await messagingService.getThreads({
      staffUid,
      tenantId: tenantOf(req),
      page: req.query.page,
      limit: req.query.limit,
      status: req.query.status,
      priority: req.query.priority,
      search: req.query.search
    });

    return success(res, result.threads, 'Threads retrieved', 200, {
      total: result.total,
      page: result.page,
      limit: result.limit
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /messaging/threads/:threadId/messages
 * Thread detail and ordered messages.
 */
router.get('/threads/:threadId/messages', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const result = await messagingService.getThreadById(
      staffUid,
      req.params.threadId,
      tenantOf(req)
    );

    return success(res, result, 'Thread retrieved');
  } catch (err) {
    next(err);
  }
});

router.patch('/threads/:threadId/archive', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }
    const result = await messagingService.setThreadArchived(
      req.params.threadId,
      staffUid,
      tenantOf(req),
      true
    );
    return success(res, result, 'Thread archived');
  } catch (err) {
    next(err);
  }
});

router.patch('/threads/:threadId/unarchive', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }
    const result = await messagingService.setThreadArchived(
      req.params.threadId,
      staffUid,
      tenantOf(req),
      false
    );
    return success(res, result, 'Thread restored');
  } catch (err) {
    next(err);
  }
});

router.patch('/threads/:threadId/mark-unread', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }
    const result = await messagingService.markThreadUnread(
      req.params.threadId,
      staffUid,
      tenantOf(req)
    );
    return success(res, result, 'Thread marked unread');
  } catch (err) {
    next(err);
  }
});

router.patch('/threads/:threadId/mute', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }
    const hours = Math.min(Math.max(parseInt(req.body?.hours) || 8, 1), 168);
    const urgentOnly = req.body?.urgent_only === true || req.body?.urgentOnly === true;
    const mutedUntil = urgentOnly
      ? null
      : req.body?.muted_until ||
        req.body?.mutedUntil ||
        new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
    const result = await messagingService.setThreadMute({
      threadId: req.params.threadId,
      staffUid,
      tenantId: tenantOf(req),
      mutedUntil,
      urgentOnly
    });
    return success(res, result, urgentOnly ? 'Thread set to urgent-only' : 'Thread muted');
  } catch (err) {
    next(err);
  }
});

router.patch('/threads/:threadId/unmute', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }
    const result = await messagingService.clearThreadMute(
      req.params.threadId,
      staffUid,
      tenantOf(req)
    );
    return success(res, result, 'Thread notifications restored');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /messaging/admin/messages
 * Admin/SuperAdmin central staff-message audit view.
 */
router.get('/admin/messages', requireAdminMessageLog, async (req, res, next) => {
  try {
    const result = await messagingService.getAdminMessageLog({
      tenantId: tenantOf(req),
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      department: req.query.department,
      priority: req.query.priority
    });

    return success(res, result.messages, 'Message log retrieved', 200, {
      total: result.total,
      page: result.page,
      limit: result.limit
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /messaging/inbox
 * Get paginated inbox for the authenticated staff member.
 * Query params: page (default 1), limit (default 20)
 */
router.get('/inbox', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const { page, limit } = req.query;
    const result = await messagingService.getInbox(staffUid, page, limit, tenantOf(req));

    return success(res, result.messages, 'Inbox retrieved', 200, {
      total: result.total,
      page: result.page,
      limit: result.limit
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /messaging/thread/:otherStaffUid
 * Get conversation thread with another staff member.
 * Query params: patient_uid (optional filter)
 */
router.get('/thread/:otherStaffUid', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const { otherStaffUid } = req.params;
    const { patient_uid } = req.query;

    const messages = await messagingService.getThread(
      staffUid,
      otherStaffUid,
      patient_uid || null,
      tenantOf(req)
    );

    return success(res, messages, 'Thread retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /messaging/patient/:patientUid
 * Get all messages about a specific patient.
 */
router.get('/patient/:patientUid', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const { patientUid } = req.params;
    const messages = await messagingService.getPatientDiscussion(patientUid, tenantOf(req));

    return success(res, messages, 'Patient discussion retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /messaging/:id/read
 * Mark a message as read.
 */
router.patch('/:id/read', paramId(), validate, async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const messageId = parseInt(req.params.id);
    if (isNaN(messageId)) {
      return error(res, 'Invalid message ID', 400);
    }

    const result = await messagingService.markAsRead(messageId, staffUid, tenantOf(req));

    return success(res, result, 'Message marked as read');
  } catch (err) {
    next(err);
  }
});

/**
 * GET /messaging/unread-count
 * Get unread message count for badge display.
 */
router.get('/unread-count', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const result = await messagingService.getUnreadCount(staffUid, tenantOf(req));

    return success(res, result, 'Unread count retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;
