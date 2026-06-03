// src/controllers/logs/logController.js
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { success, error } from '../../utils/responseHelper.js';

function applyDateFilters({ query, conditions, params, column = 'created_at' }) {
  const dateRange = String(query.dateRange || query.date_range || '').trim();
  if (dateRange) {
    const rangeSql = {
      today: `${column} >= CURRENT_DATE`,
      yesterday: `${column} >= CURRENT_DATE - INTERVAL '1 day' AND ${column} < CURRENT_DATE`,
      last_24h: `${column} >= NOW() - INTERVAL '24 hours'`,
      last_7d: `${column} >= NOW() - INTERVAL '7 days'`,
      last_30d: `${column} >= NOW() - INTERVAL '30 days'`,
    }[dateRange];
    if (rangeSql) conditions.push(rangeSql);
  }

  const from = query.from || query.start_date;
  const to = query.to || query.end_date;
  if (from) {
    params.push(from);
    conditions.push(`${column} >= $${params.length}::timestamptz`);
  }
  if (to) {
    params.push(to);
    conditions.push(`${column} < ($${params.length}::date + INTERVAL '1 day')`);
  }
}

function addIlikeFilter({ query, key, column, conditions, params }) {
  const value = typeof query[key] === 'string' ? query[key].trim() : '';
  if (!value) return;
  params.push(`%${value}%`);
  conditions.push(`${column} ILIKE $${params.length}`);
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/logs/audit  — paginated audit logs
// ────────────────────────────────────────────────────────────────────────────
export async function getAuditLogs(req, res) {
  try {
    const allowedSortFields = {
      created_at: 'created_at',
      action: 'action',
      role: 'role',
      resource: 'resource',
      ip_address: 'ip_address',
    };
    const listQuery = parseListQuery(req.query, {
      defaultLimit: 50,
      maxLimit: 500,
      defaultSortBy: 'created_at',
      defaultSortOrder: 'DESC',
      allowedSortFields: Object.keys(allowedSortFields),
      allowOffset: true,
    });

    let rows = [];
    let total = 0;

    try {
      const params = [];
      const conditions = [];
      if (listQuery.search) {
        params.push(`%${listQuery.search}%`);
        conditions.push(`(
          action ILIKE $${params.length}
          OR resource ILIKE $${params.length}
          OR role ILIKE $${params.length}
          OR resource_id::text ILIKE $${params.length}
          OR ip_address ILIKE $${params.length}
        )`);
      }
      addIlikeFilter({
        query: req.query,
        key: 'action',
        column: 'action',
        conditions,
        params,
      });
      addIlikeFilter({
        query: req.query,
        key: 'resource',
        column: 'resource',
        conditions,
        params,
      });
      addIlikeFilter({
        query: req.query,
        key: 'role',
        column: 'role',
        conditions,
        params,
      });
      applyDateFilters({ query: req.query, conditions, params });
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const listParams = [...params, listQuery.limit, listQuery.offset];
      rows = await prisma.$queryRawUnsafe(
        `SELECT id, uid, role, action, resource, resource_id, metadata,
          ip_address, user_agent, created_at
         FROM audit_logs
         ${where}
         ORDER BY ${allowedSortFields[listQuery.sortBy]} ${listQuery.sortOrder}, created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...listParams,
      );

      const countResult = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*)::int AS count FROM audit_logs ${where}`,
        ...params,
      );
      total = parseInt(countResult?.[0]?.count ?? 0, 10);
    } catch (_tableError) {
      logger.warn('[logs] audit_logs table not found or unreadable; returning empty audit logs');
    }

    const pagination = buildPagination(total, listQuery.page, listQuery.limit);
    success(res, {
      logs: Array.isArray(rows) ? rows : [],
      total,
      limit: listQuery.limit,
      offset: listQuery.offset,
      pagination,
      filters: {
        search: listQuery.search || null,
        action: req.query.action || null,
        resource: req.query.resource || null,
        role: req.query.role || null,
        dateRange: req.query.dateRange || req.query.date_range || null,
        from: req.query.from || req.query.start_date || null,
        to: req.query.to || req.query.end_date || null,
        sortBy: listQuery.sortBy,
        sortOrder: listQuery.sortOrder,
      },
    }, 'Audit logs fetched');
  } catch (err) {
    logger.error('[logs] getAuditLogs error:', err.stack || err.message);
    error(res, 'Failed to fetch audit logs', 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/logs/system  — system activity logs
// Falls back gracefully if admin_activity_logs table does not exist.
// ────────────────────────────────────────────────────────────────────────────
export async function getSystemLogs(req, res) {
  try {
    const allowedSortFields = {
      created_at: 'created_at',
      action: 'action',
      admin_uid: 'admin_uid',
      ip_address: 'ip_address',
    };
    const listQuery = parseListQuery(req.query, {
      defaultLimit: 50,
      maxLimit: 500,
      defaultSortBy: 'created_at',
      defaultSortOrder: 'DESC',
      allowedSortFields: Object.keys(allowedSortFields),
      allowOffset: true,
    });

    let rows = [];
    let total = 0;

    try {
      const params = [];
      const conditions = [];
      if (listQuery.search) {
        params.push(`%${listQuery.search}%`);
        conditions.push(`(
          action ILIKE $${params.length}
          OR description ILIKE $${params.length}
          OR admin_uid::text ILIKE $${params.length}
          OR ip_address ILIKE $${params.length}
        )`);
      }
      addIlikeFilter({
        query: req.query,
        key: 'action',
        column: 'action',
        conditions,
        params,
      });
      addIlikeFilter({
        query: req.query,
        key: 'admin_uid',
        column: 'admin_uid::text',
        conditions,
        params,
      });
      applyDateFilters({ query: req.query, conditions, params });
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const listParams = [...params, listQuery.limit, listQuery.offset];
      rows = await prisma.$queryRawUnsafe(
        `SELECT id, admin_uid, action, description, details, ip_address, created_at
         FROM admin_activity_logs
         ${where}
         ORDER BY ${allowedSortFields[listQuery.sortBy]} ${listQuery.sortOrder}, created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        ...listParams,
      );
      const countResult = await prisma.$queryRawUnsafe(
        `SELECT COUNT(*) FROM admin_activity_logs ${where}`,
        ...params,
      );
      total = parseInt(countResult?.[0]?.count ?? 0, 10);
    } catch {
      // Table does not exist yet — return empty list, not an error
      logger.warn('[logs] admin_activity_logs table not found; returning empty system logs');
    }

    const pagination = buildPagination(total, listQuery.page, listQuery.limit);
    success(res, {
      logs: Array.isArray(rows) ? rows : [],
      total,
      limit: listQuery.limit,
      offset: listQuery.offset,
      pagination,
      filters: {
        search: listQuery.search || null,
        action: req.query.action || null,
        admin_uid: req.query.admin_uid || null,
        dateRange: req.query.dateRange || req.query.date_range || null,
        from: req.query.from || req.query.start_date || null,
        to: req.query.to || req.query.end_date || null,
        sortBy: listQuery.sortBy,
        sortOrder: listQuery.sortOrder,
      },
    }, 'System logs fetched');
  } catch (err) {
    logger.error('[logs] getSystemLogs error:', err.stack || err.message);
    error(res, 'Failed to fetch system logs', 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/logs/audit/export  — CSV export of audit logs
// ────────────────────────────────────────────────────────────────────────────
export async function exportAuditLogs(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit ?? 1000), 10000);
    const offset = Number(req.query.offset ?? 0);

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, uid, role, action, resource, resource_id, metadata,
        ip_address, user_agent, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`, limit, offset);

    const csv = buildCsv(result, [
      'id', 'uid', 'role', 'action', 'resource', 'resource_id',
      'metadata', 'ip_address', 'user_agent', 'created_at',
    ]);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('[logs] exportAuditLogs error:', err.stack || err.message);
    error(res, 'Failed to export audit logs', 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/logs/system/export  — CSV export of system logs
// ────────────────────────────────────────────────────────────────────────────
export async function exportSystemLogs(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit ?? 1000), 10000);
    const offset = Number(req.query.offset ?? 0);

    let rows = [];

    try {
      const result = await prisma.$queryRawUnsafe(
        `SELECT id, admin_uid, action, description, details, ip_address, created_at
         FROM admin_activity_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`, limit, offset);
      rows = result;
    } catch {
      logger.warn('[logs] admin_activity_logs table not found; exporting empty system logs');
    }

    const columns = rows.length > 0 ? Object.keys(rows[0]) : ['id', 'action', 'created_at'];
    const csv = buildCsv(rows, columns);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="system_logs_${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('[logs] exportSystemLogs error:', err.stack || err.message);
    error(res, 'Failed to export system logs', 500);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Helper: convert rows to CSV string
// ────────────────────────────────────────────────────────────────────────────
function buildCsv(rows, columns) {
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const str = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return `"${str.replace(/"/g, '""')}"`;
  };

  const header = columns.map(escape).join(',');
  const dataRows = rows.map(row => columns.map(col => escape(row[col])).join(','));
  return [header, ...dataRows].join('\n');
}
