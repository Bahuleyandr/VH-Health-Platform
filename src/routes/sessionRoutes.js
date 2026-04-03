// src/routes/sessionRoutes.js
// Active session management routes — view and revoke sessions.

import { Router } from 'express';
import logger from '../logging/logger.js';
import { success, error } from '../utils/responseHelper.js';
import { HTTP_STATUS } from '../config/responseCodes.js';
import { listActiveSessions, revokeSession, revokeAllOtherSessions } from '../services/sessionManagementService.js';

const router = Router();

/**
 * GET /sessions
 * List active sessions for the current user.
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.uid;
    if (!userId) return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);

    const sessions = await listActiveSessions(userId);
    return success(res, sessions, 'Active sessions retrieved');
  } catch (err) {
    logger.error('List sessions error:', err);
    return error(res, 'Failed to retrieve sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * DELETE /sessions/:jti
 * Revoke a specific session.
 */
router.delete('/:jti', async (req, res) => {
  try {
    const userId = req.user?.uid;
    const { jti } = req.params;

    if (!userId) return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);
    if (!jti) return error(res, 'Session ID (jti) is required', HTTP_STATUS.BAD_REQUEST);

    const result = await revokeSession(userId, jti);
    if (!result.success) {
      return error(res, result.message, HTTP_STATUS.NOT_FOUND);
    }

    return success(res, result, 'Session revoked');
  } catch (err) {
    logger.error('Revoke session error:', err);
    return error(res, 'Failed to revoke session', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * POST /sessions/revoke-all
 * Revoke all sessions except the current one.
 */
router.post('/revoke-all', async (req, res) => {
  try {
    const userId = req.user?.uid;
    const currentJti = req.user?.jti; // From JWT claims

    if (!userId) return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);

    const result = await revokeAllOtherSessions(userId, currentJti || '');
    return success(res, result, `${result.revokedCount} session(s) revoked`);
  } catch (err) {
    logger.error('Revoke all sessions error:', err);
    return error(res, 'Failed to revoke sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
