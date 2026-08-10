// src/routes/gdprRoutes.js
// GDPR data erasure (right to be forgotten) routes.

import { Router } from 'express';
import { HTTP_STATUS } from '../config/responseCodes.js';
import { ADMIN_ROUTE_ROLES } from '../config/routeRolePolicy.js';
import logger from '../logging/logger.js';
import { requireRole } from '../middleware/rbacMiddleware.js';
import { deriveTenantIdFromRequest } from '../services/security/accessDecisionService.js';
import { executeErasure, checkLegalHold } from '../services/gdpr/dataErasureService.js';
import { isOptionalTableMissing } from '../services/security/schemaMissingGuard.js';
import { success, error, relayAppError } from '../utils/responseHelper.js';

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
    const tenantId = deriveTenantIdFromRequest(req);
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
      const holdCheck = await checkLegalHold(uid, { tenantId });
      if (holdCheck.hasHold) {
        return error(res, 'Cannot erase: user has an active legal hold', HTTP_STATUS.FORBIDDEN, {
          code: 'LEGAL_HOLD_ACTIVE',
        });
      }
    }

    const result = await executeErasure({
      uid,
      phone,
      requestedBy,
      reason,
      ip,
      requestId: req.id,
      tenantId,
    });

    return success(res, result, 'Data erasure completed');
  } catch (err) {
    return relayAppError(res, err, 'Data erasure failed');
  }
});

/**
 * GET /gdpr/erasure-log
 * View GDPR erasure audit trail.
 * Admin only.
 */
router.get('/erasure-log', requireRole(...ADMIN_ROUTE_ROLES), async (req, res) => {
  let logs;
  let erasureLogTableMissing = false;
  try {
    const { default: prisma } = await import('../lib/prisma.js');
    const tenantId = deriveTenantIdFromRequest(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    logs = await prisma.$queryRawUnsafe(
      `SELECT id, uid, phone_hash, requested_by, reason, tables_processed,
              completed_at, duration_ms, created_at
       FROM gdpr_erasure_log
       WHERE EXISTS (
         SELECT 1
           FROM users u
          WHERE u.uid = gdpr_erasure_log.uid
            AND u.tenant_id = $3::uuid
       )
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      limit, offset, tenantId
    );

  } catch (err) {
    // This log is DPDP/GDPR compliance evidence. A database fault must never
    // be presented as "no erasures happened" — only a verified missing-table
    // condition for this exact optional table (SQLSTATE 42P01 outside
    // production) may return an empty result, and then only with an explicit
    // caveat the caller can see.
    if (isOptionalTableMissing(err, 'gdpr_erasure_log')) {
      logger.warn('GDPR erasure log table missing (42P01) — returning explicit empty result');
      erasureLogTableMissing = true;
    } else {
      logger.error('GDPR erasure log error:', err);
      return relayAppError(res, err, 'Failed to retrieve erasure log');
    }
  }

  if (erasureLogTableMissing) {
    return success(
      res,
      [],
      'Erasure log table does not exist yet — no erasure evidence has been recorded',
      HTTP_STATUS.OK,
      { table_missing: true },
    );
  }
  return success(res, logs, 'Erasure log retrieved');
});

export default router;
