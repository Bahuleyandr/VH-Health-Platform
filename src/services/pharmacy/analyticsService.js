import db from '../../config/database.js';
import logger from '../../logging/logger.js';

export const getPharmacyAnalytics = async () => {
  const [orderStats, revenueStats, popularMeds] = await Promise.all([
    // Order statistics
    db.query(`
      SELECT 
        COUNT(*) as total_orders,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_orders,
        COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_orders,
        COUNT(CASE WHEN status = 'ready' THEN 1 END) as ready_orders,
        COUNT(CASE WHEN status = 'dispensed' THEN 1 END) as dispensed_orders,
        COUNT(CASE WHEN urgent = true THEN 1 END) as urgent_orders
      FROM pharmacy_orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '30 days'
    `),

    // Revenue statistics
    db.query(`
      SELECT 
        TO_CHAR(created_at, 'DD-MM-YYYY') as order_date,
        COUNT(*) as orders_count
      FROM pharmacy_orders
      WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
      GROUP BY TO_CHAR(created_at, 'DD-MM-YYYY')
      ORDER BY order_date DESC
    `),

    // Most requested medications (mock data)
    db.query(`
      SELECT category, COUNT(*) as request_count
      FROM pharmacy_orders po
      JOIN medications m ON po.order_note ILIKE '%' || m.name || '%'
      WHERE po.created_at >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY category
      ORDER BY request_count DESC
      LIMIT 10
    `).catch(() => ({ rows: [] })) // Fallback if join fails
  ]);

  return {
    order_statistics: orderStats.rows[0],
    weekly_trends: revenueStats.rows,
    popular_categories: popularMeds.rows
  };
};