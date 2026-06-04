// src/routes/gdprRoutes.js
// GDPR data erasure (right to be forgotten) routes.

import { Router } from 'express';
import { HTTP_STATUS } from '../config/responseCodes.js';
import { ADMIN_ROUTE_ROLES } from '../config/routeRolePolicy.js';
import logger from '../logging/logger.js';
import { requireRole } from '../middleware/rbacMiddleware.js';
import { executeErasure, checkLegalHold } from '../services/gdpr/dataErasureService.js';
import { success, error } from '../utils/responseHelper.js';

const router = Router();

/**
 * POST /gdpr/erase
 * Execute GDPR data erasure for a user.
 * Admin only — requires uid and/or phone.
 * Body: { uid, phone, reason }
 */
router.post('/erase', requireRole(...ADMIN_ROUTE_ROLES), async (req, res) => {
  try {
    const { uid, phone, reason } = req.body;
    const requestedBy = req.user?.uid || 'unknown';
    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    if (!uid && !phone) {
      return error(res, 'Either uid or phone is required', HTTP_STATUS.BAD_REQUEST);
    }
    if (!reason) {
      return error(res, 'Reason for erasure is required for audit trail', HTTP_STATUS.BAD_REQUEST);
    }

    // Check legal holds
    if (uid) {
      const holdCheck = await checkLegalHold(uid);
      if (holdCheck.hasHold) {
        return error(res, 'Cannot erase: user has an active legal hold', HTTP_STATUS.FORBIDDEN);
      }
    }

    const result = await executeErasure({
      uid,
      phone,
      requestedBy,
      reason,
      ip,
      requestId: req.id,
    });

    return success(res, result, 'Data erasure completed');
  } catch (err) {
    logger.error('GDPR erasure route error:', err);
    return error(res, 'Data erasure failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
});

/**
 * GET /gdpr/erasure-log
 * View GDPR erasure audit trail.
 * Admin only.
 */
router.get('/erasure-log', requireRole(...ADMIN_ROUTE_ROLES), async (req, res) => {
  try {
    const { default: prisma } = await import('../lib/prisma.js');
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const logs = await prisma.$queryRawUnsafe(
      `SELECT id, uid, phone_hash, requested_by, reason, tables_processed,
              completed_at, duration_ms, created_at
       FROM gdpr_erasure_log
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      limit, offset
    );

    return success(res, logs, 'Erasure log retrieved');
  } catch (err) {
    logger.error('GDPR erasure log error:', err);
    return success(res, [], 'Erasure log table may not exist yet');
  }
});

export default router;
