// src/services/pharmacy/analyticsService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';

export const getPharmacyAnalytics = async () => {
  const [orderStats, revenueStats, popularMeds] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int                                            AS total_orders,
        COUNT(CASE WHEN status = 'PENDING'    THEN 1 END)::int  AS pending_orders,
        COUNT(CASE WHEN status = 'PREPARING'  THEN 1 END)::int  AS processing_orders,
        COUNT(CASE WHEN status = 'READY'      THEN 1 END)::int  AS ready_orders,
        COUNT(CASE WHEN status = 'DELIVERED'  THEN 1 END)::int  AS dispensed_orders,
        COUNT(CASE WHEN urgent = true          THEN 1 END)::int  AS urgent_orders
      FROM pharmacy_orders
      WHERE ordered_at >= CURRENT_DATE - INTERVAL '30 days'
    `,
    prisma.$queryRaw`
      SELECT
        TO_CHAR(ordered_at, 'DD-MM-YYYY') AS order_date,
        COUNT(*)::int                      AS orders_count
      FROM pharmacy_orders
      WHERE ordered_at >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY TO_CHAR(ordered_at, 'DD-MM-YYYY')
      ORDER BY order_date DESC
    `,
    prisma.$queryRaw`
      SELECT m.category, COUNT(*)::int AS request_count
      FROM pharmacy_orders po
      JOIN medications m ON po.order_note ILIKE '%' || m.name || '%'
      WHERE po.ordered_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY m.category
      ORDER BY request_count DESC
      LIMIT 10
    `.catch(() => []),
  ]);

  return {
    order_statistics: orderStats[0],
    weekly_trends: revenueStats,
    popular_categories: popularMeds,
  };
};
