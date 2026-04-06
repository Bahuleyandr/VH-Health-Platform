// src/services/pharmacy/inventoryService.js
// Migrated from raw pg to Prisma ORM

import prisma from '../../lib/prisma.js';

export const getLowStockMedications = async (threshold) => {
  const medications = await prisma.medications.findMany({
    where: {
      is_active: true,
      stock_quantity: { lte: parseInt(threshold), gt: 0 },
    },
    select: {
      id: true, name: true, generic_name: true, brand: true,
      category: true, stock_quantity: true, price: true,
      expiry_date: true, manufacturer: true,
    },
    orderBy: [{ stock_quantity: 'asc' }, { expiry_date: 'asc' }],
  });

  return { medications, count: medications.length, threshold };
};

export const getExpiredMedications = async () => {
  const medications = await prisma.medications.findMany({
    where: {
      is_active: true,
      expiry_date: { lt: new Date() },
    },
    select: {
      id: true, name: true, generic_name: true, brand: true,
      category: true, stock_quantity: true, expiry_date: true,
      manufacturer: true, price: true,
    },
    orderBy: { expiry_date: 'desc' },
  });

  return { medications, count: medications.length };
};

export const getExpiringSoonMedications = async (days) => {
    const future = new Date();
  future.setDate(future.getDate() + parseInt(days));

  const rows = await prisma.$queryRaw`
    SELECT id, name, generic_name, brand, category, stock_quantity,
           TO_CHAR(expiry_date, 'DD-MM-YYYY') AS expiry_date,
           manufacturer, price,
           (expiry_date::date - CURRENT_DATE)::int AS days_to_expiry
    FROM medications
    WHERE expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + (${parseInt(days)} || ' days')::interval
      AND is_active = true
    ORDER BY expiry_date ASC
  `;

  return { medications: rows, count: rows.length, expiry_window_days: days };
};

export const getMedicationCategories = async () => {
  const rows = await prisma.$queryRaw`
    SELECT category,
           COUNT(*)::int          AS medication_count,
           SUM(stock_quantity)::int AS total_stock,
           ROUND(AVG(price)::numeric, 2) AS average_price
    FROM medications
    WHERE is_active = true
    GROUP BY category
    ORDER BY category
  `;

  return { categories: rows, count: rows.length };
};

export const getInventorySummary = async () => {
  const [totalStats, categoryStats, stockStats] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(*)::int                              AS total_medications,
        SUM(stock_quantity)::int                   AS total_stock_items,
        ROUND(SUM(stock_quantity * price)::numeric, 2) AS total_inventory_value,
        ROUND(AVG(price)::numeric, 2)              AS average_price
      FROM medications
      WHERE is_active = true
    `,
    prisma.$queryRaw`
      SELECT category, COUNT(*)::int AS count
      FROM medications
      WHERE is_active = true
      GROUP BY category
      ORDER BY count DESC
    `,
    prisma.$queryRaw`
      SELECT
        COUNT(CASE WHEN stock_quantity = 0 THEN 1 END)::int                                     AS out_of_stock,
        COUNT(CASE WHEN stock_quantity > 0 AND stock_quantity <= 10 THEN 1 END)::int             AS low_stock,
        COUNT(CASE WHEN stock_quantity > 10 THEN 1 END)::int                                    AS in_stock,
        COUNT(CASE WHEN expiry_date < CURRENT_DATE THEN 1 END)::int                             AS expired,
        COUNT(CASE WHEN expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days' THEN 1 END)::int AS expiring_soon
      FROM medications
      WHERE is_active = true
    `,
  ]);

  return {
    totals: totalStats[0],
    categories: categoryStats,
    stock_status: stockStats[0],
  };
};
