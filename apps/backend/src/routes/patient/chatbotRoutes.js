// Patient-facing RAG chatbot routes.
// Mounted at /api/v1/patient/chatbot in app.js. Every endpoint verifies
// that the caller owns the target conversation (JWT uid == patient_uid)
// via the service layer; SUPER_ADMIN may view for audit.

import express from 'express';
import { success, error } from '../../utils/responseHelper.js';
import {
  listMessages,
  listMyConversations,
  sendMessage,
  startConversation,
} from '../../services/ai/patientChatbotService.js';

const router = express.Router();

router.get('/conversations', async (req, res, next) => {
  try {
    const result = await listMyConversations({ req, limit: req.query.limit });
    return success(res, result, 'Conversations retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/conversations', async (req, res, next) => {
  try {
    if (!req.user?.uid) return error(res, 'Authentication required', 401);
    const conv = await startConversation({
      tenantId: req.tenantId,
      patientUid: req.user.uid,
      title: req.body?.title || null,
    });
    return success(res, conv, 'Conversation started', 201);
  } catch (err) {
    return next(err);
  }
});

router.get('/conversations/:id/messages', async (req, res, next) => {
  try {
    const result = await listMessages({ req, conversationId: req.params.id, limit: req.query.limit });
    return success(res, result, 'Messages retrieved');
  } catch (err) {
    return next(err);
  }
});

router.post('/conversations/:id/messages', async (req, res, next) => {
  try {
    const result = await sendMessage({
      req,
      conversationId: req.params.id,
      message: req.body?.message,
    });
    return success(res, result, 'Reply generated');
  } catch (err) {
    return next(err);
  }
});

export default router;
