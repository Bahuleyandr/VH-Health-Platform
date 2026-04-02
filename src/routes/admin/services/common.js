// src/routes/admin/services/common.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

/**
 * Check if a table exists in the public schema.
 */
export async function tableExists(table) {
  try {
    const { rows } = await prisma.$queryRawUnsafe(`SELECT to_regclass($1) AS reg`, [`public.${table}`]);
    return Boolean(rows[0]?.reg);
  } catch {
    return false;
  }
}

/**
 * Check if a column exists on a table in the public schema.
 */
export async function columnExists(table, column) {
  try {
    const { rows } = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Run a query that should never throw; on error, warn and return [].
 */
export async function safeQuery(sql, params = [], label = 'query') {
  try {
    const r = await prisma.$queryRawUnsafe(sql, params);
    return r.rows;
  } catch (err) {
    logger.warn(`[admin:${label}] skipped: ${err.message}`);
    return [];
  }
}

/**
 * Fetch a single numeric scalar safely; on error or null, return fallback (default 0).
 */
export async function safeScalar(sql, params = [], fallback = 0) {
  try {
    const { rows } = await prisma.$queryRawUnsafe(sql, params);
    const v = rows[0] && Object.values(rows[0])[0];
    if (v == null || Number.isNaN(Number(v))) return fallback;
    return Number(v);
  } catch (err) {
    logger.warn(`[admin:scalar] ${err.message}`);
    return fallback;
  }
}

export default { tableExists, columnExists, safeQuery, safeScalar };
