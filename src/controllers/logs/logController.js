// src/controllers/logs/logController.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// ────────────────────────────────────────────────────────────────────────────
// GET /api/v1/logs/audit  — paginated audit logs
// ────────────────────────────────────────────────────────────────────────────
export async function getAuditLogs(req, res) {
  try {
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Number(req.query.offset ?? 0);

    const result = await db.query(
      `SELECT id, uid, role, action, resource, resource_id, metadata,
        ip_address, user_agent, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await db.query(`SELECT COUNT(*) FROM audit_logs`);
    const total = parseInt(countResult.rows[0].count, 10);

    success(res, { logs: result.rows, total, limit, offset }, 'Audit logs fetched');
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
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const offset = Number(req.query.offset ?? 0);

    let rows = [];
    let total = 0;

    try {
      const result = await db.query(
        `SELECT id, admin_uid, action, description, details, ip_address, created_at
         FROM admin_activity_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      const countResult = await db.query(`SELECT COUNT(*) FROM admin_activity_logs`);
      rows = result.rows;
      total = parseInt(countResult.rows[0].count, 10);
    } catch {
      // Table does not exist yet — return empty list, not an error
      logger.warn('[logs] admin_activity_logs table not found; returning empty system logs');
    }

    success(res, { logs: rows, total, limit, offset }, 'System logs fetched');
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

    const result = await db.query(
      `SELECT id, uid, role, action, resource, resource_id, metadata,
        ip_address, user_agent, created_at
       FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const csv = buildCsv(result.rows, [
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
      const result = await db.query(
        `SELECT id, admin_uid, action, description, details, ip_address, created_at
         FROM admin_activity_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
      rows = result.rows;
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
