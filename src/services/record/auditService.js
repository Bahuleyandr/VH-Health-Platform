// src/services/record/auditService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AUDIT_ACTIONS } from '../../config/recordConfig.js';

export async function logAuditEntry(action, tableName, recordId, userId, userRole, changes) {
  try {
    await db.query(
      `INSERT INTO audit_logs (action, table_name, record_id, user_id, user_role, changes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      [action, tableName, recordId, userId, userRole, JSON.stringify(changes)]
    );
  } catch (error) {
    logger.error(`[AuditService] Failed to log audit entry: ${error.message}`);
    // Don't throw - audit failures shouldn't break main operations
  }
}

export async function getAuditLogs(startDate, endDate, limit = 1000) {
  try {
    const result = await db.query(`
      SELECT 
        action, table_name, record_id, user_id, user_role,
        TO_CHAR(created_at, 'DD-MM-YYYY HH24:MI:SS') as access_time,
        changes
      FROM audit_logs 
      WHERE table_name IN ('medical_records', 'health_records')
        AND created_at BETWEEN COALESCE($1::date, CURRENT_DATE - INTERVAL '30 days') 
                           AND COALESCE($2::date, CURRENT_DATE + INTERVAL '1 day')
      ORDER BY created_at DESC
      LIMIT $3
    `, [startDate, endDate, limit]);
    
    return result.rows;
  } catch (error) {
    logger.error(`[AuditService] Failed to retrieve audit logs: ${error.message}`);
    return [];
  }
}

export function calculateComplianceMetrics(auditData) {
  const metrics = {
    totalAccesses: auditData.length,
    uniqueUsers: new Set(auditData.map(row => row.user_id)).size,
    recordsAccessed: new Set(auditData.map(row => row.record_id)).size,
    actionBreakdown: {}
  };

  auditData.forEach(row => {
    metrics.actionBreakdown[row.action] = 
      (metrics.actionBreakdown[row.action] || 0) + 1;
  });

  return metrics;
}