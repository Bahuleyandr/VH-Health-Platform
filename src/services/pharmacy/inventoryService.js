import db from '../../config/database.js';
import logger from '../../logging/logger.js';

export const getLowStockMedications = async (threshold) => {
  const result = await db.query(`
    SELECT id, name, generic_name, brand, category, stock_quantity, 
           price, TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, manufacturer
    FROM medications 
    WHERE stock_quantity <= $1 AND stock_quantity > 0 AND is_active = true
    ORDER BY stock_quantity ASC, expiry_date ASC
  `, [threshold]);

  return {
    medications: result.rows,
    count: result.rows.length,
    threshold
  };
};

export const getExpiredMedications = async () => {
  const result = await db.query(`
    SELECT id, name, generic_name, brand, category, stock_quantity, 
           TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, manufacturer, price
    FROM medications 
    WHERE expiry_date < CURRENT_DATE AND is_active = true
    ORDER BY expiry_date DESC
  `);

  return {
    medications: result.rows,
    count: result.rows.length
  };
};

export const getExpiringSoonMedications = async (days) => {
  const result = await db.query(`
    SELECT id, name, generic_name, brand, category, stock_quantity, 
           TO_CHAR(expiry_date, 'DD-MM-YYYY') as expiry_date, manufacturer, price,
           expiry_date - CURRENT_DATE as days_to_expiry
    FROM medications 
    WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '${days} days'
      AND is_active = true
    ORDER BY expiry_date ASC
  `);

  return {
    medications: result.rows,
    count: result.rows.length,
    expiry_window_days: days
  };
};

export const getMedicationCategories = async () => {
  const result = await db.query(`
    SELECT category, 
           COUNT(*) as medication_count,
           SUM(stock_quantity) as total_stock,
           ROUND(AVG(price), 2) as average_price
    FROM medications 
    WHERE is_active = true
    GROUP BY category
    ORDER BY category
  `);

  return {
    categories: result.rows,
    count: result.rows.length
  };
};

export const getInventorySummary = async () => {
  const [totalStats, categoryStats, stockStats] = await Promise.all([
    // Total inventory statistics
    db.query(`
      SELECT 
        COUNT(*) as total_medications,
        SUM(stock_quantity) as total_stock_items,
        ROUND(SUM(stock_quantity * price), 2) as total_inventory_value,
        ROUND(AVG(price), 2) as average_price
      FROM medications 
      WHERE is_active = true
    `),
    
    // Category breakdown
    db.query(`
      SELECT category, COUNT(*) as count
      FROM medications 
      WHERE is_active = true
      GROUP BY category
      ORDER BY count DESC
    `),
    
    // Stock status
    db.query(`
      SELECT 
        COUNT(CASE WHEN stock_quantity = 0 THEN 1 END) as out_of_stock,
        COUNT(CASE WHEN stock_quantity > 0 AND stock_quantity <= 10 THEN 1 END) as low_stock,
        COUNT(CASE WHEN stock_quantity > 10 THEN 1 END) as in_stock,
        COUNT(CASE WHEN expiry_date < CURRENT_DATE THEN 1 END) as expired,
        COUNT(CASE WHEN expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' THEN 1 END) as expiring_soon
      FROM medications 
      WHERE is_active = true
    `)
  ]);

  return {
    totals: totalStats.rows[0],
    categories: categoryStats.rows,
    stock_status: stockStats.rows[0]
  };
};