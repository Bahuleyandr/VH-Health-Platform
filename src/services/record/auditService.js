// src/services/record/auditService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import { AUDIT_ACTIONS } from '../../config/recordConfig.js';
import logger from '../../logging/logger.js';

export async function logAuditEntry(action, tableName, recordId, userId, userRole, changes) {
  try {
    const metadata = {
      ...changes,
      table_name: tableName,
      record_id: recordId,
      audit_action_type: action,
    };

    await prisma.audit_logs.create({
      data: {
        uid: userId || null,
        role: userRole || 'SYSTEM',
        action: `${action}_${tableName}`,
        metadata,
        ip_address: '127.0.0.1',
      },
    });
  } catch (error) {
    logger.error(`[AuditService] Failed to log audit entry: ${error.message}`);
    // Don't throw — audit failures shouldn't break main operations
  }
}

export async function getAuditLogs(startDate, endDate, limit = 1000) {
  try {
    const from = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 86400000);
    const to = endDate ? new Date(endDate) : new Date(Date.now() + 86400000);

    const rows = await prisma.$queryRaw`
      SELECT
        uid, role, action,
        TO_CHAR(created_at, 'DD-MM-YYYY HH24:MI:SS') AS access_time,
        metadata,
        ip_address
      FROM audit_logs
      WHERE (
        action LIKE '%medical_records%' OR
        action LIKE '%health_records%' OR
        metadata->>'table_name' IN ('medical_records', 'health_records')
      )
        AND created_at BETWEEN ${from} AND ${to}
      ORDER BY created_at DESC
      LIMIT ${parseInt(limit)}
    `;

    return rows.map(row => ({
      action: row.metadata?.audit_action_type || row.action,
      table_name: row.metadata?.table_name || 'unknown',
      record_id: row.metadata?.record_id || null,
      user_id: row.uid,
      user_role: row.role,
      access_time: row.access_time,
      changes: row.metadata,
      ip_address: row.ip_address,
    }));
  } catch (error) {
    logger.error(`[AuditService] Failed to retrieve audit logs: ${error.message}`);
    return [];
  }
}

export function calculateComplianceMetrics(auditData) {
  const metrics = {
    totalAccesses: auditData.length,
    uniqueUsers: new Set(auditData.map(row => row.user_id).filter(Boolean)).size,
    recordsAccessed: new Set(auditData.map(row => row.record_id).filter(Boolean)).size,
    actionBreakdown: {},
  };

  auditData.forEach(row => {
    const action = row.action || 'unknown';
    metrics.actionBreakdown[action] = (metrics.actionBreakdown[action] || 0) + 1;
  });

  return metrics;
}
