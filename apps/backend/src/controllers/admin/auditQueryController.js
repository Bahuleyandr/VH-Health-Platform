import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
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
             al.request_summary, al.error_message,
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

// GET /api/v1/admin/audit/unified
// Normalized clinical governance feed across request audit, patient-access
// decisions, and canonical clinical action audit. This is additive: the
// legacy /logs endpoint remains unchanged for API/request troubleshooting.
export const getUnifiedAuditLogs = async (req, res) => {
  try {
    const {
      source,
      action,
      actor_uid,
      patient_uid,
      status,
      from,
      to,
      search,
      limit = 100,
      offset = 0,
    } = req.query;

    const tenantId = req.tenantId || req.user?.tenant_id || req.user?.tenantId || null;
    const conditions = [];
    const params = [];
    let idx = 1;

    if (source) { conditions.push(`source = $${idx++}`); params.push(String(source)); }
    if (action) { conditions.push(`action ILIKE $${idx++}`); params.push(`%${action}%`); }
    if (actor_uid) { conditions.push(`actor_uid = $${idx++}`); params.push(String(actor_uid)); }
    if (patient_uid) { conditions.push(`patient_uid = $${idx++}`); params.push(String(patient_uid)); }
    if (status) { conditions.push(`action_status = $${idx++}`); params.push(String(status)); }
    if (from) { conditions.push(`occurred_at >= $${idx++}::timestamptz`); params.push(from); }
    if (to) { conditions.push(`occurred_at <= $${idx++}::timestamptz`); params.push(to); }
    if (tenantId) {
      conditions.push(`(tenant_id IS NULL OR tenant_id = $${idx++})`);
      params.push(String(tenantId));
    }
    if (search) {
      conditions.push(`(
        action ILIKE $${idx}
        OR COALESCE(resource_type, '') ILIKE $${idx}
        OR COALESCE(resource_table, '') ILIKE $${idx}
        OR COALESCE(summary, '') ILIKE $${idx}
      )`);
      params.push(`%${search}%`);
      idx += 1;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limitVal = Math.min(parseInt(limit, 10) || 100, 500);
    const offsetVal = parseInt(offset, 10) || 0;
    params.push(limitVal, offsetVal);

    const query = `
      WITH combined AS (
        SELECT
          'request'::text AS source,
          NULL::text AS tenant_id,
          al.id::text AS id,
          al.created_at AS occurred_at,
          al.user_id::text AS actor_uid,
          al.user_role::text AS actor_role,
          NULL::text AS patient_uid,
          al.action::text AS action,
          CASE WHEN al.success THEN 'success' ELSE 'failure' END::text AS action_status,
          al.module::text AS resource_type,
          NULL::text AS resource_table,
          NULL::text AS resource_id,
          CONCAT(al.method, ' ', al.path)::text AS summary,
          jsonb_build_object(
            'method', al.method,
            'path', al.path,
            'status_code', al.status_code,
            'response_time_ms', al.response_time_ms,
            'request_summary', al.request_summary,
            'error_message', al.error_message
          ) AS metadata
        FROM audit_log al

        UNION ALL

        SELECT
          'clinical'::text AS source,
          cae.tenant_id::text AS tenant_id,
          cae.id::text AS id,
          cae.occurred_at AS occurred_at,
          cae.actor_uid::text AS actor_uid,
          cae.actor_role::text AS actor_role,
          cae.patient_uid::text AS patient_uid,
          cae.action::text AS action,
          cae.action_status::text AS action_status,
          cae.resource_type::text AS resource_type,
          cae.resource_table::text AS resource_table,
          cae.resource_id::text AS resource_id,
          COALESCE(cae.metadata->>'summary', cae.action)::text AS summary,
          jsonb_build_object(
            'encounter_id', cae.encounter_id,
            'request_id', cae.request_id,
            'before_state', cae.before_state,
            'after_state', cae.after_state,
            'metadata', cae.metadata
          ) AS metadata
        FROM clinical_audit_events cae

        UNION ALL

        SELECT
          'patient_access'::text AS source,
          pa.tenant_id::text AS tenant_id,
          pa.id::text AS id,
          pa.created_at AS occurred_at,
          pa.actor_uid::text AS actor_uid,
          pa.actor_role::text AS actor_role,
          pa.patient_uid::text AS patient_uid,
          COALESCE(pa.action, 'patient_access')::text AS action,
          pa.access_decision::text AS action_status,
          'patient_access'::text AS resource_type,
          NULL::text AS resource_table,
          COALESCE(pa.care_team_id::text, pa.break_glass_id::text) AS resource_id,
          COALESCE(pa.reason, pa.access_source)::text AS summary,
          jsonb_build_object(
            'access_source', pa.access_source,
            'route', pa.route,
            'request_id', pa.request_id,
            'care_team_id', pa.care_team_id,
            'break_glass_id', pa.break_glass_id,
            'metadata', pa.metadata
          ) AS metadata
        FROM patient_access_audit_log pa
      )
      SELECT *
        FROM combined
        ${where}
       ORDER BY occurred_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`;

    const rows = await prisma.$queryRawUnsafe(query, ...params);
    return success(res, {
      logs: rows,
      limit: limitVal,
      offset: offsetVal,
      filters: {
        source: source || null,
        action: action || null,
        actor_uid: actor_uid || null,
        patient_uid: patient_uid || null,
        status: status || null,
        from: from || null,
        to: to || null,
        search: search || null,
      },
    }, 'Unified audit logs fetched');
  } catch (err) {
    logger.error('Unified Audit Logs Error:', err);
    error(res, 'Failed to fetch unified audit logs', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// GET /api/v1/admin/audit/summary
// High-level stats for dashboard
export const getAuditSummary = async (req, res) => {
  try {
    const { hours = 24 } = req.query;
    const interval = `${parseInt(hours)} hours`;

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
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT user_name, user_role, COUNT(*) as action_count,
               COUNT(*) FILTER (WHERE method != 'GET') as writes,
               COUNT(*) FILTER (WHERE success = false) as failures
        FROM audit_log
        WHERE created_at >= NOW() - $1::INTERVAL
          AND user_id IS NOT NULL
        GROUP BY user_name, user_role
        ORDER BY action_count DESC LIMIT 10
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT module, COUNT(*) as count,
               COUNT(*) FILTER (WHERE success = false) as failures
        FROM audit_log
        WHERE created_at >= NOW() - $1::INTERVAL
        GROUP BY module ORDER BY count DESC
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT id, user_name, method, path, status_code, error_message, created_at, response_time_ms
        FROM audit_log
        WHERE success = false
          AND created_at >= NOW() - $1::INTERVAL
        ORDER BY created_at DESC LIMIT 20
      `, interval),

      prisma.$queryRawUnsafe(`
        SELECT id, user_name, method, path, response_time_ms, created_at
        FROM audit_log
        WHERE response_time_ms > 2000
          AND created_at >= NOW() - $1::INTERVAL
        ORDER BY response_time_ms DESC LIMIT 10
      `, interval),
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

    const logs = await prisma.$queryRawUnsafe(`
      SELECT id, method, path, module, action, status_code, response_time_ms,
             success, request_summary, ip_address, created_at
      FROM audit_log
      WHERE user_id = $1
        AND created_at >= NOW() - $2::INTERVAL
      ORDER BY created_at DESC
      LIMIT $3
    `, userId, `${parseInt(days)} days`, Math.min(parseInt(limit), 500));

    const stats = await prisma.$queryRawUnsafe(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE method != 'GET') as writes,
        COUNT(*) FILTER (WHERE success = false) as failures,
        array_agg(DISTINCT module) FILTER (WHERE module IS NOT NULL) as modules_accessed
      FROM audit_log
      WHERE user_id = $1
        AND created_at >= NOW() - $2::INTERVAL
    `, userId, `${parseInt(days)} days`);

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
    const modules = await prisma.$queryRawUnsafe(`SELECT DISTINCT module FROM audit_log WHERE module IS NOT NULL ORDER BY module`);
    const actions = await prisma.$queryRawUnsafe(`SELECT DISTINCT action FROM audit_log WHERE action IS NOT NULL ORDER BY action`);
    success(res, {
      modules: modules.map(r => r.module),
      actions: actions.map(r => r.action),
    }, 'Modules fetched');
  } catch (err) {
    logger.error('Audit Modules Error:', err);
    error(res, 'Failed to fetch modules', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
