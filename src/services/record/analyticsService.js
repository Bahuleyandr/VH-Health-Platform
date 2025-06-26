// src/services/record/analyticsService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';

export async function getRecordAnalytics(days = 30) {
  try {
    const [recordStats, privacyStats, activityStats, errorStats] = await Promise.all([
      // Record type distribution
      db.query(`
        SELECT record_type, COUNT(*) as count,
               COUNT(CASE WHEN created_at > NOW() - INTERVAL '${days} days' THEN 1 END) as recent_count
        FROM medical_records 
        GROUP BY record_type
        ORDER BY count DESC
      `),

      // Privacy level distribution  
      db.query(`
        SELECT privacy_level,
               CASE privacy_level
                 WHEN 0 THEN 'PUBLIC'
                 WHEN 1 THEN 'RESTRICTED'
                 WHEN 2 THEN 'CONFIDENTIAL'
                 WHEN 3 THEN 'HIGHLY_CONFIDENTIAL'
                 ELSE 'UNKNOWN'
               END as privacy_name,
               COUNT(*) as count
        FROM medical_records 
        GROUP BY privacy_level
        ORDER BY privacy_level
      `),

      // Activity by role
      db.query(`
        SELECT created_by_role, COUNT(*) as records_created,
               COUNT(DISTINCT patient_id) as patients_treated
        FROM health_records 
        WHERE created_at > NOW() - INTERVAL '${days} days'
        GROUP BY created_by_role
      `),

      // Mock security alerts for demo
      Promise.resolve({
        rows: [
          { error_type: 'PRIVACY_VIOLATION', count: 15 },
          { error_type: 'UNAUTHORIZED_ACCESS', count: 8 },
          { error_type: 'INVALID_RECORD_TYPE', count: 3 }
        ]
      })
    ]);

    return {
      recordDistribution: recordStats.rows,
      privacyLevels: privacyStats.rows,
      roleActivity: activityStats.rows,
      securityAlerts: errorStats.rows,
      totalRecords: recordStats.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
      recentRecords: recordStats.rows.reduce((sum, row) => sum + parseInt(row.recent_count), 0)
    };
  } catch (error) {
    logger.error(`[AnalyticsService] Error getting analytics: ${error.message}`);
    // Return empty data on error
    return {
      recordDistribution: [],
      privacyLevels: [],
      roleActivity: [],
      securityAlerts: [],
      totalRecords: 0,
      recentRecords: 0
    };
  }
}