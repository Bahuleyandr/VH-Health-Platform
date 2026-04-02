// src/services/health/healthStatsService.js
import prisma from '../../lib/prisma.js';
import { createPrismaDb } from '../../lib/prismaCompat.js';
import { TREND_PERIODS } from '../../config/healthConfig.js';
import logger from '../../logging/logger.js';

const db = createPrismaDb(prisma);

export async function getHealthStatistics(days = TREND_PERIODS.WEEK) {
  try {
    const [recordStats, typeStats, dailyActivity] = await Promise.all([
      // Total health record statistics
      prisma.$queryRawUnsafe(`
        SELECT 
          COUNT(*) as total_records,
          COUNT(DISTINCT patient_id) as unique_patients,
          COUNT(CASE WHEN recorded_date >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_records
        FROM health_records
      `),
      
      // Record type breakdown
      prisma.$queryRawUnsafe(`
        SELECT record_type, COUNT(*) as count
        FROM health_records 
        WHERE recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY record_type
        ORDER BY count DESC
      `),
      
      // Daily activity
      prisma.$queryRawUnsafe(`
        SELECT DATE(recorded_date) as date, COUNT(*) as records_count
        FROM health_records 
        WHERE recorded_date >= CURRENT_DATE - INTERVAL '${days} days'
        GROUP BY DATE(recorded_date)
        ORDER BY date DESC
      `)
    ]);
    
    return {
      totals: recordStats[0],
      by_type: typeStats.rows,
      daily_activity: dailyActivity.rows
    };
  } catch (error) {
    logger.error(`[HealthStatsService] Error getting health statistics: ${error.message}`);
    // Return empty statistics on error
    return {
      totals: {
        total_records: 0,
        unique_patients: 0,
        recent_records: 0
      },
      by_type: [],
      daily_activity: []
    };
  }
}