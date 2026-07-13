import { createHash } from 'node:crypto';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  exportAuditEvents,
  getAuditEventDetail,
  getAuditHealth,
  listAuditEvents,
  recordAuditConsoleAccess,
} from '../../services/compliance/auditAccountabilityService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';

// GET /api/v1/admin/audit/logs
// Query params: user_id, module, action, method, status_code, success, from, to, limit, offset, search
export const getAuditLogs = async (req, res) => {
  try {
    const {
      user_id, module: mod, action, method, status_code, success: successFilter,
      from, to, limit = 100, offset = 0, search,
    } = req.query;

    const conditions = [];
    const params = [];
    let idx = 1;

    // CAN-042: always scope the audit feed to the caller's tenant (defense-in-depth
    // alongside RLS). The count query reuses these condition params (it slices off
    // only the trailing limit/offset), so this predicate applies to both.
    conditions.push(`al.tenant_id = $${idx++}`); params.push(resolveTenantOrThrow(req));

    if (user_id)                        { conditions.push(`al.user_id = $${idx++}`); params.push(user_id); }
    if (mod)                            { conditions.push(`al.module = $${idx++}`); params.push(mod); }
    if (action)                         { conditions.push(`al.action = $${idx++}`); params.push(action); }
    if (method)                         { conditions.push(`al.method = $${idx++}`); params.push(method.toUpperCase()); }
    if (status_code)                    { conditions.push(`al.status_code = $${idx++}`); params.push(parseInt(status_code)); }
    if (successFilter !== undefined)    { conditions.push(`al.success = $${idx++}`); params.push(successFilter === 'true'); }
    if (from)                           { conditions.push(`al.created_at >= $${idx++}::timestamptz`); params.push(from); }
    if (to)                             { conditions.push(`al.created_at <= $${idx++}::timestamptz`); params.push(to); }
    if (search) {
      conditions.push(`(al.path ILIKE $${idx} OR al.action ILIKE $${idx} OR al.user_name ILIKE $${idx})`);
      params.push(`%${search}%`);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitVal  = Math.min(parseInt(limit), 500);
    const offsetVal = parseInt(offset);
    params.push(limitVal, offsetVal);

    const logs = await prisma.$queryRawUnsafe(`
      SELECT al.id, al.user_id, al.user_name, al.user_role, al.ip_address,
             al.method, al.path, al.module, al.action,
             al.status_code, al.response_time_ms, al.success,
             CASE
               WHEN al.module IN (
                 'clinical_notes', 'clinical_orders', 'vitals', 'intake_output',
                 'drug_chart', 'discharge_summaries', 'investigations',
                 'prescriptions', 'diagnoses', 'referrals', 'blood_bank',
                 'medication_administration', 'handovers'
               ) OR al.path LIKE '/api/v1/staff/medical/%'
               THEN '[REDACTED_CLINICAL_REQUEST]'
               ELSE al.request_summary
             END AS request_summary,
             al.error_message,
             al.created_at
      FROM audit_log al
      ${where}
      ORDER BY al.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
    `, ...params);

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*) FROM audit_log al ${where}`,
      ...params.slice(0, -2)
    );

    success(res, {
      logs: logs,
      total: parseInt(countResult[0].count),
      limit: limitVal,
      offset: offsetVal,
    }, 'Audit logs fetched');
  } catch (err) {
    logger.error('Get Audit Logs Error:', err);
    error(res, 'Failed to fetch audit logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

function auditError(res, err, operation) {
  if (err?.isOperational && err?.statusCode) {
    return error(res, err.message, err.statusCode, { code: err.code });
  }
  logger.error(`${operation} Error:`, err);
  return error(res, `Failed to ${operation.toLowerCase()}`, HTTP_STATUS.INTERNAL_SERVER_ERROR);
}

// GET /api/v1/admin/audit/events
// Compatibility alias: GET /api/v1/admin/audit/unified
export const getUnifiedAuditLogs = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const result = await listAuditEvents(tenantId, req.query);
    await recordAuditConsoleAccess(req, 'AUDIT_EVENTS_VIEW', {
      filters: result.filters,
      returned_count: result.logs.length,
    });
    return success(res, result, 'Unified audit events fetched');
  } catch (err) {
    return auditError(res, err, 'Fetch unified audit events');
  }
};

// GET /api/v1/admin/audit/events/:source/:id
export const getUnifiedAuditEventDetail = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const result = await getAuditEventDetail(tenantId, req.params.source, req.params.id);
    await recordAuditConsoleAccess(req, 'AUDIT_EVENT_DETAIL_VIEW', {
      source: req.params.source,
      source_id: req.params.id,
      patient_uid: result.event.patient_uid || null,
    });
    return success(res, result, 'Audit event detail fetched');
  } catch (err) {
    return auditError(res, err, 'Fetch audit event detail');
  }
};

// GET /api/v1/admin/audit/export
export const exportUnifiedAuditEvents = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const result = await exportAuditEvents(tenantId, req.query);
    const generatedAt = new Date().toISOString();
    const actorUid = /^[0-9a-f-]{36}$/i.test(String(req.user?.uid || ''))
      ? String(req.user.uid)
      : 'unknown';
    const body = Buffer.from(`\uFEFF${result.csv}`, 'utf8');
    const digest = createHash('sha256').update(body).digest('base64');
    await recordAuditConsoleAccess(req, 'AUDIT_EVENTS_EXPORT', {
      filters: result.filters,
      exported_count: result.row_count,
      generated_at: generatedAt,
      actor_uid: actorUid === 'unknown' ? null : actorUid,
      sha256_digest: digest,
    });
    const date = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="audit-events-${date}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Digest', `sha-256=${digest}`);
    res.setHeader('X-Audit-Export-Generated-At', generatedAt);
    res.setHeader('X-Audit-Export-Actor-Uid', actorUid);
    return res.status(200).send(body);
  } catch (err) {
    return auditError(res, err, 'Export audit events');
  }
};

// GET /api/v1/admin/audit/health
export const getUnifiedAuditHealth = async (req, res) => {
  try {
    const tenantId = resolveTenantOrThrow(req);
    const result = await getAuditHealth(tenantId, req.query);
    await recordAuditConsoleAccess(req, 'AUDIT_HEALTH_VIEW', { window: result.window });
    return success(res, result, 'Audit health fetched');
  } catch (err) {
    return auditError(res, err, 'Fetch audit health');
  }
};

// GET /api/v1/admin/audit/summary
// High-level stats for dashboard
export const getAuditSummary = async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const interval = `${parseInt(hours)} hours`;
    // CAN-042: scope every summary aggregate to the caller's tenant.
    const tenantId = resolveTenantOrThrow(req);

    const [activity, topUsers, topModules, errors, slowRequests] = await Promise.all([
      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*) as total_requests,
          COUNT(*) FILTER (WHERE success = false) as failed_requests,
          COUNT(*) FILTER (WHERE method != 'GET') as write_actions,
          COUNT(DISTINCT user_id) as unique_users,
          ROUND(AVG(response_time_ms)::NUMERIC, 0) as avg_response_ms,
          MAX(response_time_ms) as max_response_ms
        FROM audit_log
        WHERE created_at >= NOW() - $1::INTERVAL
          AND tenant_id = $2::uuid
      `, interval, tenantId),

      prisma.$queryRawUnsafe(`
        SELECT user_name, user_role, COUNT(*) as action_count,
               COUNT(*) FILTER (WHERE method != 'GET') as writes,
               COUNT(*) FILTER (WHERE success = false) as failures
        FROM audit_log
        WHERE created_at >= NOW() - $1::INTERVAL
          AND user_id IS NOT NULL
          AND tenant_id = $2::uuid
        GROUP BY user_name, user_role
        ORDER BY action_count DESC LIMIT 10
      `, interval, tenantId),

      prisma.$queryRawUnsafe(`
        SELECT module, COUNT(*) as count,
               COUNT(*) FILTER (WHERE success = false) as failures
        FROM audit_log
        WHERE created_at >= NOW() - $1::INTERVAL
          AND tenant_id = $2::uuid
        GROUP BY module ORDER BY count DESC
      `, interval, tenantId),

      prisma.$queryRawUnsafe(`
        SELECT id, user_name, method, path, status_code, error_message, created_at, response_time_ms
        FROM audit_log
        WHERE success = false
          AND created_at >= NOW() - $1::INTERVAL
          AND tenant_id = $2::uuid
        ORDER BY created_at DESC LIMIT 20
      `, interval, tenantId),

      prisma.$queryRawUnsafe(`
        SELECT id, user_name, method, path, response_time_ms, created_at
        FROM audit_log
        WHERE response_time_ms > 2000
          AND created_at >= NOW() - $1::INTERVAL
          AND tenant_id = $2::uuid
        ORDER BY response_time_ms DESC LIMIT 10
      `, interval, tenantId),
    ]);

    success(res, {
      period_hours: parseInt(hours),
      activity: activity[0],
      top_users: topUsers,
      top_modules: topModules,
      recent_errors: errors,
      slow_requests: slowRequests,
    }, 'Audit summary fetched');
  } catch (err) {
    logger.error('Audit Summary Error:', err);
    error(res, 'Failed to fetch audit summary', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /api/v1/admin/audit/user/:userId
// All actions by a specific user — for investigating someone
export const getUserAuditHistory = async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 200, days = 30 } = req.query;
    // CAN-042: scope the per-user audit history to the caller's tenant.
    const tenantId = resolveTenantOrThrow(req);

    const logs = await prisma.$queryRawUnsafe(`
      SELECT id, method, path, module, action, status_code, response_time_ms,
             success,
             CASE
               WHEN module IN (
                 'clinical_notes', 'clinical_orders', 'vitals', 'intake_output',
                 'drug_chart', 'discharge_summaries', 'investigations',
                 'prescriptions', 'diagnoses', 'referrals', 'blood_bank',
                 'medication_administration', 'handovers'
               ) OR path LIKE '/api/v1/staff/medical/%'
               THEN '[REDACTED_CLINICAL_REQUEST]'
               ELSE request_summary
             END AS request_summary,
             ip_address, created_at
      FROM audit_log
      WHERE user_id = $1
        AND created_at >= NOW() - $2::INTERVAL
        AND tenant_id = $4::uuid
      ORDER BY created_at DESC
      LIMIT $3
    `, userId, `${parseInt(days)} days`, Math.min(parseInt(limit), 500), tenantId);

    const stats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE method != 'GET') as writes,
        COUNT(*) FILTER (WHERE success = false) as failures,
        array_agg(DISTINCT module) FILTER (WHERE module IS NOT NULL) as modules_accessed
      FROM audit_log
      WHERE user_id = $1
        AND created_at >= NOW() - $2::INTERVAL
        AND tenant_id = $3::uuid
    `, userId, `${parseInt(days)} days`, tenantId);

    success(res, {
      user_id: userId,
      period_days: parseInt(days),
      stats: stats[0],
      logs: logs,
    }, 'User audit history fetched');
  } catch (err) {
    logger.error('User Audit History Error:', err);
    error(res, 'Failed to fetch user history', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /api/v1/admin/audit/modules
export const getAuditModules = async (req, res) => {
  try {
    // CAN-042: scope the distinct module/action facets to the caller's tenant.
    const tenantId = resolveTenantOrThrow(req);
    const modules = await prisma.$queryRawUnsafe(`SELECT DISTINCT module FROM audit_log WHERE module IS NOT NULL AND tenant_id = $1::uuid ORDER BY module`, tenantId);
    const actions = await prisma.$queryRawUnsafe(`SELECT DISTINCT action FROM audit_log WHERE action IS NOT NULL AND tenant_id = $1::uuid ORDER BY action`, tenantId);
    success(res, {
      modules: modules.map(r => r.module),
      actions: actions.map(r => r.action),
    }, 'Modules fetched');
  } catch (err) {
    logger.error('Audit Modules Error:', err);
    error(res, 'Failed to fetch modules', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
