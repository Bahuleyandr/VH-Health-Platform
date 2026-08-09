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
 * The caller's own token claims, as verified by jwtMiddleware. Threaded into
 * the service so a session can be reported (and revoked) even on login paths
 * that never claimed a `user_active_sessions` row — the admin paths mint
 * tokens with generateToken() directly (audit P15).
 */
const callerToken = (req) => ({
  jti: req.user?.jti ?? null,
  expiresAt: req.user?.tokenExpiresAt ?? null,
});

/**
 * GET /sessions
 * List sessions currently visible to the partial registry.
 */
router.get('/', async (req, res) => {
  try {
    const userId = req.user?.uid;
    if (!userId) return error(res, 'Authentication required', HTTP_STATUS.UNAUTHORIZED);

    const result = await listActiveSessions(userId, callerToken(req));
    return success(res, result, 'Known sessions retrieved; list is not exhaustive');
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

    const result = await revokeSession(userId, jti, callerToken(req));
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
      if (result.code === SESSION_REVOKE_FAILURE.REGISTRY_INCOMPLETE) {
        return error(
          res,
          'Bulk session revocation is unavailable until all active tokens are registered',
          501,
          { code: result.code },
        );
      }
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
