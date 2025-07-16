// src/services/record/auditService.js
import db from '../../config/database.js';
import { AUDIT_ACTIONS } from '../../config/recordConfig.js';
import logger from '../../logging/logger.js';

export async function logAuditEntry(action, tableName, recordId, userId, userRole, changes) {
  try {
    // Adapt to your existing audit_logs structure
    const metadata = {
      ...changes,
      table_name: tableName,
      record_id: recordId,
      audit_action_type: action
    };

    await db.query(
      `INSERT INTO audit_logs (uid, role, action, metadata, ip, timestamp)
       VALUES ($1::uuid, $2, $3, $4, $5, NOW())`,
      [
        userId || null,  // uid can be null if system action
        userRole || 'SYSTEM',
        `${action}_${tableName}`, // Combine action and table name
        JSON.stringify(metadata),
        '127.0.0.1' // Default IP for internal actions
      ]
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
        uid,
        role,
        action,
        TO_CHAR(timestamp, 'DD-MM-YYYY HH24:MI:SS') as access_time,
        metadata,
        ip
      FROM audit_logs 
      WHERE (
        action LIKE '%medical_records%' OR 
        action LIKE '%health_records%' OR
        metadata->>'table_name' IN ('medical_records', 'health_records')
      )
        AND timestamp BETWEEN COALESCE($1::date, CURRENT_DATE - INTERVAL '30 days') 
                          AND COALESCE($2::date, CURRENT_DATE + INTERVAL '1 day')
      ORDER BY timestamp DESC
      LIMIT $3
    `, [startDate, endDate, limit]);
    
    // Transform data to expected format
    return result.rows.map(row => ({
      action: row.metadata?.audit_action_type || row.action,
      table_name: row.metadata?.table_name || 'unknown',
      record_id: row.metadata?.record_id || null,
      user_id: row.uid,
      user_role: row.role,
      access_time: row.access_time,
      changes: row.metadata,
      ip_address: row.ip
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
    actionBreakdown: {}
  };

  auditData.forEach(row => {
    const action = row.action || 'unknown';
    metrics.actionBreakdown[action] = 
      (metrics.actionBreakdown[action] || 0) + 1;
  });

  return metrics;
}