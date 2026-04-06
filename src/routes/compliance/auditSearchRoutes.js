// src/routes/compliance/auditSearchRoutes.js
// Compliance Audit Log Search — search audit_log with filters, paginated

import { Router } from 'express';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success } from '../../utils/responseHelper.js';

const router = Router();

/**
 * GET /compliance/audit/search
 * Search audit logs with filters.
 * Query params:
 *   - patient_uid   (who was accessed — searches request_summary)
 *   - staff_uid     (who accessed — matches user_id)
 *   - date_from     (ISO date string, inclusive)
 *   - date_to       (ISO date string, inclusive)
 *   - action        (what was done, e.g. 'view', 'create', 'consent_check')
 *   - module        (e.g. 'consent', 'compliance', 'appointments')
 *   - page          (default 1)
 *   - limit         (default 50, max 200)
 */
router.get('/audit/search', async (req, res, next) => {
  try {
    const {
      patient_uid,
      staff_uid,
      date_from,
      date_to,
      action,
      module,
      page = 1,
      limit = 50,
    } = req.query;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (staff_uid) {
      conditions.push(`user_id = $${paramIndex++}`);
      params.push(staff_uid);
    }

    if (patient_uid) {
      conditions.push(`request_summary LIKE $${paramIndex++}`);
      params.push(`%${patient_uid}%`);
    }

    if (date_from) {
      conditions.push(`created_at >= $${paramIndex++}`);
      params.push(date_from);
    }

    if (date_to) {
      conditions.push(`created_at <= $${paramIndex++}`);
      params.push(date_to);
    }

    if (action) {
      conditions.push(`action = $${paramIndex++}`);
      params.push(action);
    }

    if (module) {
      conditions.push(`module = $${paramIndex++}`);
      params.push(module);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sanitizedLimit = Math.min(Math.max(1, parseInt(limit) || 50), 200);
    const sanitizedPage = Math.max(1, parseInt(page) || 1);
    const offset = (sanitizedPage - 1) * sanitizedLimit;

    // Count total matching rows
    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) AS total FROM audit_log ${whereClause}`,
      params
    );
    const total = parseInt(countResult[0].total);

    // Fetch paginated results
    params.push(sanitizedLimit);
    params.push(offset);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, user_id, user_name, user_role, ip_address, method, path,
              module, action, query_params, request_summary,
              status_code, response_time_ms, success, user_agent, created_at
       FROM audit_log
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      params
    );

    return success(res, result, 'Audit logs retrieved', 200, {
      page: sanitizedPage,
      limit: sanitizedLimit,
      total,
      totalPages: Math.ceil(total / sanitizedLimit),
    });
  } catch (err) {
    logger.error('Failed to search audit logs:', { error: err.message });
    next(err);
  }
});

export default router;
