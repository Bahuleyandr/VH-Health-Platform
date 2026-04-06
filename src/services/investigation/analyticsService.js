// src/services/investigation/analyticsService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';
import { formatDateDDMMYYYY } from '../../utils/investigation/investigationHelpers.js';

export const getInvestigationStats = async (days) => {
  const daysInt = parseInt(days, 10);

  const [totalStats, typeStats, statusStats, dailyActivity] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int                                                          AS total_investigations,
        COUNT(CASE WHEN status = 'PENDING'   THEN 1 END)::int                 AS pending,
        COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)::int                 AS completed,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END)::int                 AS cancelled,
        COUNT(CASE WHEN ordered_date >= CURRENT_DATE - (${daysInt} || ' days')::interval THEN 1 END)::int AS recent_orders,
        ROUND(AVG(cost)::numeric, 2)                                          AS average_cost
      FROM investigations
    `,
    prisma.$queryRaw`
      SELECT type, COUNT(*)::int AS count
      FROM investigations
      WHERE ordered_date >= CURRENT_DATE - (${daysInt} || ' days')::interval
      GROUP BY type
      ORDER BY count DESC
    `,
    prisma.$queryRaw`
      SELECT status, COUNT(*)::int AS count
      FROM investigations
      WHERE ordered_date >= CURRENT_DATE - (${daysInt} || ' days')::interval
      GROUP BY status
      ORDER BY count DESC
    `,
    prisma.$queryRaw`
      SELECT DATE(ordered_date) AS date, COUNT(*)::int AS investigations_ordered
      FROM investigations
      WHERE ordered_date >= CURRENT_DATE - (${daysInt} || ' days')::interval
      GROUP BY DATE(ordered_date)
      ORDER BY date DESC
    `,
  ]);

  return {
    totals: totalStats[0],
    by_type: typeStats,
    by_status: statusStats,
    daily_activity: dailyActivity.map(row => ({
      ...row,
      date: formatDateDDMMYYYY(row.date),
    })),
  };
};
