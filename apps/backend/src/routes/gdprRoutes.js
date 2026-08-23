// src/routes/gdprRoutes.js
// GDPR data erasure (right to be forgotten) routes.

import { Router } from 'express';
import { HTTP_STATUS } from '../config/responseCodes.js';
import logger from '../logging/logger.js';
import { requireRole } from '../middleware/rbacMiddleware.js';
import { deriveTenantIdFromRequest } from '../services/security/accessDecisionService.js';
import { executeErasure, checkLegalHold } from '../services/gdpr/dataErasureService.js';
import { success, error, relayAppError } from '../utils/responseHelper.js';

const router = Router();

/**
 * In-route SUPER_ADMIN gate (same intent as the databaseRoutes.js gate, spelled
 * with the shared `requireRole` because this mount has no upstream role check
 * to inherit and because a denied attempt on an irreversible console belongs in
 * the security audit trail — rbacMiddleware emits `PERMISSION_DENIED`, an
 * inline role comparison does not).
 *
 * Both routes previously used `requireRole(...ADMIN_ROUTE_ROLES)`, which
 * resolves to ['SUPER_ADMIN', 'ADMIN'] (config/rolePolicyGraph.js), so a plain
 * tenant ADMIN could run an irreversible erasure. The admin portal has always
 * declared this console SUPER_ADMIN-only (apps/admin/src/lib/navConfig.ts —
 * "GDPR Erasure", requiredRole: "SUPER_ADMIN"); the backend now agrees.
 *
 * `/erasure-log` is gated too, not just the mutation: it is the DPDP/GDPR
 * evidence ledger and returns the uid, phone_hash, requester and stated reason
 * for every erased data subject — sensitive material in its own right.
 *
 * Note: `/api/v1/gdpr` is NOT mounted under `/api/v1/admin`, so it inherits
 * neither `requireSuperAdminStepUp` nor `adminIpAllowlist`. Adding step-up here
 * is a worthwhile follow-up but is outside this fix.
 */
const requireSuperAdmin = requireRole('SUPER_ADMIN');

/**
 * POST /gdpr/erase
 * Execute GDPR data erasure for a user.
 * SUPER_ADMIN only — requires uid and/or phone.
 * Body: { uid, phone, reason }
 */
router.post('/erase', requireSuperAdmin, async (req, res) => {
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
 * SUPER_ADMIN only — the rows carry erased-subject identifiers.
 */
router.get('/erasure-log', requireSuperAdmin, async (req, res) => {
  try {
    const { default: prisma } = await import('../lib/prisma.js');
    const tenantId = deriveTenantIdFromRequest(req);
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const logs = await prisma.$queryRawUnsafe(
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
    return success(res, logs, 'Erasure log retrieved');
  } catch (err) {
    logger.error('GDPR erasure log error:', err);
    return relayAppError(res, err, 'Failed to retrieve erasure log');
  }
});

export default router;
