import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { formatDateDDMMYYYY } from '../../utils/investigation/investigationHelpers.js';

export const getInvestigationStats = async (days) => {
  const [totalStats, typeStats, statusStats, dailyActivity] = await Promise.all([
    // Total investigation statistics
    db.query(`
      SELECT 
        COUNT(*) as total_investigations,
        COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled,
        COUNT(CASE WHEN ordered_date >= CURRENT_DATE - INTERVAL '${days} days' THEN 1 END) as recent_orders,
        ROUND(AVG(cost), 2) as average_cost
      FROM investigations
    `),
    
    // Type breakdown
    db.query(`
      SELECT type, COUNT(*) as count
      FROM investigations 
      WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
      GROUP BY type
      ORDER BY count DESC
    `),
    
    // Status distribution
    db.query(`
      SELECT status, COUNT(*) as count
      FROM investigations 
      WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
      GROUP BY status
      ORDER BY count DESC
    `),
    
    // Daily activity
    db.query(`
      SELECT DATE(ordered_date) as date, COUNT(*) as investigations_ordered
      FROM investigations 
      WHERE ordered_date >= CURRENT_DATE - INTERVAL '${days} days'
      GROUP BY DATE(ordered_date)
      ORDER BY date DESC
    `)
  ]);

  return {
    totals: totalStats.rows[0],
    by_type: typeStats.rows,
    by_status: statusStats.rows,
    daily_activity: dailyActivity.rows.map(row => ({
  ...row,
  date: formatDateDDMMYYYY(row.date)
}))
  };
};