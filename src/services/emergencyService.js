// src/services/emergencyService.js
import prisma from '../lib/prisma.js';
import { RESPONSE_TIMES } from '../config/sosConfig.js';
import logger from '../logging/logger.js';


const query = async (sql, params = []) => {
  const normalizedSql = sql.trim();
  const upperSql = normalizedSql.toUpperCase();
  const usesReturning = /\bRETURNING\b/i.test(normalizedSql);
  const isReadQuery = upperSql.startsWith('SELECT') || upperSql.startsWith('WITH') || usesReturning;

  if (isReadQuery) {
    const rows = await prisma.$queryRawUnsafe(normalizedSql, ...params);
    return { rows, rowCount: Array.isArray(rows) ? rows.length : 0 };
  }

  const rowCount = await prisma.$executeRawUnsafe(normalizedSql, ...params);
  return { rows: [], rowCount: Number(rowCount) || 0 };
};


export const getActiveAlerts = async () => {
  const result = await query(`
    SELECT 
      sa.id, sa.phone, sa.severity, sa.message, sa.emergency_type,
      sa.latitude, sa.longitude, sa.created_at, sa.status,
      sa.medical_conditions, sa.medications, sa.emergency_contact,
      sa.blood_group, sa.allergies, sa.preferred_hospital,
      u.name as user_name, u.age, u.gender,
      EXTRACT(EPOCH FROM (NOW() - sa.created_at))/60 as minutes_elapsed,
      resp.name as responder_name,
      sa.response_message, sa.estimated_arrival
    FROM sos_alerts sa
    LEFT JOIN users u ON sa.phone = u.phone
    LEFT JOIN users resp ON sa.responder_uid = resp.uid
    WHERE sa.status IN ('active', 'responding')
      AND sa.is_test_alert = false
    ORDER BY 
      CASE sa.severity 
        WHEN 'critical' THEN 1
        WHEN 'high' THEN 2  
        WHEN 'medium' THEN 3
        WHEN 'low' THEN 4
      END,
      sa.created_at ASC
  `);

  return result.rows;
};

export const calculateDashboardStats = (alerts) => {
  return {
    total: alerts.length,
    critical: alerts.filter(a => a.severity === 'critical').length,
    high: alerts.filter(a => a.severity === 'high').length,
    medium: alerts.filter(a => a.severity === 'medium').length,
    low: alerts.filter(a => a.severity === 'low').length,
    overdue: alerts.filter(a => a.minutes_elapsed > 30).length,
    responding: alerts.filter(a => a.status === 'responding').length
  };
};

// ... other emergency service methods