// src/controllers/logs/logsController.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

async function tableExists(tableName) {
  try {
    const r = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
      [tableName]
    );
    return r.length > 0;
  } catch {
    return false;
  }
}

function parsePagination(query) {
  const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit ?? '50', 10) || 50));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

// ─── audit logs ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/logs/audit
 * Query params: page, limit, action, role, start_date, end_date
 */
export async function getAuditLogs(req, res) {
  try {
    if (!(await tableExists('audit_logs'))) {
      return success(res, { logs: [], total: 0, page: 1, limit: 50 }, 'No audit logs yet');
    }

    const { page, limit, offset } = parsePagination(req.query);
    const { action, role, start_date, end_date } = req.query;

    const params = [];
    const where = [];

    if (action) {
      params.push(`%${action}%`);
      where.push(`action ILIKE $${params.length}`);
    }
    if (role) {
      params.push(role.toUpperCase());
      where.push(`role = $${params.length}`);
    }
    if (start_date) {
      params.push(start_date);
      where.push(`COALESCE(timestamp, created_at) >= $${params.length}::date`);
    }
    if (end_date) {
      params.push(end_date);
      where.push(`COALESCE(timestamp, created_at) < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countResult = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS total FROM audit_logs ${whereClause}`,
      params
    );
    const total = countResult[0]?.total ?? 0;

    params.push(limit, offset);
    const dataResult = await prisma.$queryRawUnsafe(
      `SELECT id, uid, role, action, ip, metadata,
              COALESCE(timestamp, created_at) AS occurred_at
       FROM audit_logs
       ${whereClause}
       ORDER BY occurred_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    success(
      res,
      { logs: dataResult.rows, total, page, limit, totalPages: Math.ceil(total / limit) },
      'Audit logs fetched'
    );
  } catch (err) {
    logger.error('[logs] getAuditLogs error:', err.stack || err.message);
    error(res, 'Failed to fetch audit logs', 500);
  }
}

/**
 * GET /api/v1/logs/audit/export
 * Returns all matching logs as JSON for client-side CSV/Excel export.
 */
export async function exportAuditLogs(req, res) {
  try {
    if (!(await tableExists('audit_logs'))) {
      return success(res, [], 'No audit logs to export');
    }

    const { action, role, start_date, end_date } = req.query;
    const params = [];
    const where = [];

    if (action) {
      params.push(`%${action}%`);
      where.push(`action ILIKE $${params.length}`);
    }
    if (role) {
      params.push(role.toUpperCase());
      where.push(`role = $${params.length}`);
    }
    if (start_date) {
      params.push(start_date);
      where.push(`COALESCE(timestamp, created_at) >= $${params.length}::date`);
    }
    if (end_date) {
      params.push(end_date);
      where.push(`COALESCE(timestamp, created_at) < ($${params.length}::date + INTERVAL '1 day')`);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, uid, role, action, ip, metadata,
              COALESCE(timestamp, created_at) AS occurred_at
       FROM audit_logs
       ${whereClause}
       ORDER BY occurred_at DESC
       LIMIT 5000`,
      params
    );

    success(res, result.rows, `Audit log export: ${result.length} records`);
  } catch (err) {
    logger.error('[logs] exportAuditLogs error:', err.stack || err.message);
    error(res, 'Failed to export audit logs', 500);
  }
}

// ─── system logs ─────────────────────────────────────────────────────────────

/**
 * Build a synthetic system log list from sources we do have:
 *   - sos_alerts  → emergency events
 *   - audit_logs  → security events (limit to recent entries)
 * This avoids requiring a dedicated system_logs table that doesn't exist yet.
 */
async function buildSystemLogs({ limit, offset, start_date, end_date, level }) {
  const logs = [];

  // Source 1: SOS alerts as system events
  if (await tableExists('sos_alerts')) {
    const params = [];
    const where = [];
    if (start_date) { params.push(start_date); where.push(`created_at >= $${params.length}::date`); }
    if (end_date)   { params.push(end_date);   where.push(`created_at < ($${params.length}::date + INTERVAL '1 day')`); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      const r = await prisma.$queryRawUnsafe(
        `SELECT id, 'emergency' AS category, 'WARN' AS level,
                'SOS alert triggered' AS message,
                jsonb_build_object('status', status, 'location', location) AS metadata,
                created_at
         FROM sos_alerts ${whereClause}
         ORDER BY created_at DESC LIMIT 500`,
        params
      );
      logs.push(...r.rows);
    } catch { /* table may have different schema */ }
  }

  // Source 2: audit_logs — recent security-relevant entries
  if (await tableExists('audit_logs')) {
    const params = [];
    const where = [];
    if (start_date) { params.push(start_date); where.push(`COALESCE(timestamp, created_at) >= $${params.length}::date`); }
    if (end_date)   { params.push(end_date);   where.push(`COALESCE(timestamp, created_at) < ($${params.length}::date + INTERVAL '1 day')`); }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    try {
      const r = await prisma.$queryRawUnsafe(
        `SELECT id, 'audit' AS category, 'INFO' AS level,
                action AS message,
                jsonb_build_object('uid', uid, 'role', role, 'ip', ip) AS metadata,
                COALESCE(timestamp, created_at) AS created_at
         FROM audit_logs ${whereClause}
         ORDER BY created_at DESC LIMIT 500`,
        params
      );
      logs.push(...r.rows);
    } catch { /* schema mismatch */ }
  }

  // Sort combined list by created_at desc
  logs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  // Apply level filter after merge
  const filtered = level
    ? logs.filter((l) => l.level?.toUpperCase() === level.toUpperCase())
    : logs;

  const total = filtered.length;
  const paginated = filtered.slice(offset, offset + limit);

  return { logs: paginated, total };
}

/**
 * GET /api/v1/logs/system
 * Query params: page, limit, level (INFO|WARN|ERROR), start_date, end_date
 */
export async function getSystemLogs(req, res) {
  try {
    const { page, limit, offset } = parsePagination(req.query);
    const { level, start_date, end_date } = req.query;

    const { logs, total } = await buildSystemLogs({ limit, offset, start_date, end_date, level });

    success(
      res,
      { logs, total, page, limit, totalPages: Math.ceil(total / limit) },
      'System logs fetched'
    );
  } catch (err) {
    logger.error('[logs] getSystemLogs error:', err.stack || err.message);
    error(res, 'Failed to fetch system logs', 500);
  }
}

/**
 * GET /api/v1/logs/system/export
 */
export async function exportSystemLogs(req, res) {
  try {
    const { level, start_date, end_date } = req.query;
    const { logs } = await buildSystemLogs({
      limit: 5000,
      offset: 0,
      start_date,
      end_date,
      level,
    });
    success(res, logs, `System log export: ${logs.length} records`);
  } catch (err) {
    logger.error('[logs] exportSystemLogs error:', err.stack || err.message);
    error(res, 'Failed to export system logs', 500);
  }
}
