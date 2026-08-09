// src/routes/sessionRoutes.js
// Active session management routes — view and revoke sessions.

import { Router } from 'express';
import { HTTP_STATUS } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import {
  listActiveSessions,
  revokeSession,
  revokeAllOtherSessions,
  SESSION_REVOKE_FAILURE,
} from '../services/sessionManagementService.js';
import { success, error } from '../utils/responseHelper.js';

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
      // A revocation store that refused the write is NOT a missing session —
      // reporting it as 404 (or worse, 200) tells the caller their token is
      // dead when it is still live (audit follow-up P12).
      const status = result.code === SESSION_REVOKE_FAILURE.STORE_UNAVAILABLE
        ? HTTP_STATUS.SERVICE_UNAVAILABLE
        : HTTP_STATUS.NOT_FOUND;
      return error(res, result.message, status, { code: result.code });
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
    if (!result.success) {
      // Partial success is still a failure to honour the request: the caller
      // asked for every other session to end, and some are demonstrably still
      // live. Report the real counts rather than a green summary line.
      return error(
        res,
        `Only ${result.revokedCount} of ${result.revokedCount + result.failedCount} session(s) could be revoked`,
        HTTP_STATUS.SERVICE_UNAVAILABLE,
        { code: result.code, revokedCount: result.revokedCount, failedCount: result.failedCount },
      );
    }
    return success(res, result, `${result.revokedCount} session(s) revoked`);
  } catch (err) {
    logger.error('Revoke all sessions error:', err);
    return error(res, 'Failed to revoke sessions', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

export default router;
