// src/services/health/healthStatsService.js
import { TREND_PERIODS } from '../../config/healthConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';


export async function getHealthStatistics(days = TREND_PERIODS.WEEK) {
  try {
    // `days` is a sanitized integer from the controller (parseInt || 7), safe to
    // interpolate into the INTERVAL literal. The live `health_records` table is a
    // file-upload store: the timestamp column is `created_at` (not the
    // never-existed `recorded_date`) and a record's patient is identified by
    // `phone` (there is no `patient_id`). Previously both wrong names raised
    // 42703, swallowed by the catch → the endpoint always returned zeros.
    const safeDays = Number.parseInt(days, 10) || 7;
    const [recordStats, typeStats, dailyActivity] = await Promise.all([
      // Total health record statistics. Cast COUNT(...) to ::int so Prisma
      // returns JS numbers (raw COUNT is BigInt → res.json would throw).
      prisma.$queryRawUnsafe(`
        SELECT
          COUNT(*)::int as total_records,
          COUNT(DISTINCT phone)::int as unique_patients,
          COUNT(CASE WHEN created_at >= CURRENT_DATE - INTERVAL '${safeDays} days' THEN 1 END)::int as recent_records
        FROM health_records
      `),

      // Record type breakdown
      prisma.$queryRawUnsafe(`
        SELECT record_type, COUNT(*)::int as count
        FROM health_records
        WHERE created_at >= CURRENT_DATE - INTERVAL '${safeDays} days'
        GROUP BY record_type
        ORDER BY count DESC
      `),

      // Daily activity
      prisma.$queryRawUnsafe(`
        SELECT DATE(created_at) as date, COUNT(*)::int as records_count
        FROM health_records
        WHERE created_at >= CURRENT_DATE - INTERVAL '${safeDays} days'
        GROUP BY DATE(created_at)
        ORDER BY date DESC
      `)
    ]);
    
    return {
      totals: recordStats[0],
      by_type: typeStats,
      daily_activity: dailyActivity
    };
  } catch (error) {
    logger.error(`[HealthStatsService] Error getting health statistics: ${error.message}`);
    throw error;
  }
}