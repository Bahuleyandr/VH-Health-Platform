// src/routes/messaging/messagingRoutes.js

import express from 'express';
import messagingService from '../../services/messaging/messagingService.js';
import { success, error } from '../../utils/responseHelper.js';
import { sanitizeBody } from '../../middleware/sanitizeMiddleware.js';
import { isStaff } from '../../utils/roleHelpers.js';
import logger from '../../logging/logger.js';

const router = express.Router();

// Sanitize message text fields
const sanitizeMessageFields = sanitizeBody('body', 'subject');

/**
 * POST /messaging/send
 * Send a message to another staff member.
 */
router.post('/send', sanitizeMessageFields, async (req, res, next) => {
  try {
    const senderUid = req.user?.uid;
    if (!senderUid) {
      return error(res, 'Authentication required', 401);
    }

    const { recipient_uid, body, priority, patient_uid, subject } = req.body;

    if (!recipient_uid || !body) {
      return error(res, 'recipient_uid and body are required', 400);
    }

    const message = await messagingService.sendMessage(
      senderUid,
      recipient_uid,
      body,
      priority || 'normal',
      patient_uid || null,
      subject || null
    );

    return success(res, message, 'Message sent successfully', 201);
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
    const result = await messagingService.getInbox(staffUid, page, limit);

    return success(res, result.messages, 'Inbox retrieved', 200, {
      total: result.total,
      page: result.page,
      limit: result.limit,
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
      patient_uid || null
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
    const messages = await messagingService.getPatientDiscussion(patientUid);

    return success(res, messages, 'Patient discussion retrieved');
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /messaging/:id/read
 * Mark a message as read.
 */
router.patch('/:id/read', async (req, res, next) => {
  try {
    const staffUid = req.user?.uid;
    if (!staffUid) {
      return error(res, 'Authentication required', 401);
    }

    const messageId = parseInt(req.params.id);
    if (isNaN(messageId)) {
      return error(res, 'Invalid message ID', 400);
    }

    const result = await messagingService.markAsRead(messageId, staffUid);

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

    const result = await messagingService.getUnreadCount(staffUid);

    return success(res, result, 'Unread count retrieved');
  } catch (err) {
    next(err);
  }
});

export default router;
