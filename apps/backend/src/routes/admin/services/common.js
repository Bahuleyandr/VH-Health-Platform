// src/routes/admin/services/common.js
import prisma from '../../../lib/prisma.js';

/**
 * Check if a table exists in the public schema.
 *
 * Note: cast to_regclass to TEXT — Prisma's raw driver can't deserialize
 * the native `regclass` Postgres OID type and throws
 * "Failed to deserialize column of type 'regclass'", which used to fire
 * 5+ times in parallel on every dashboard load and trip the circuit
 * breaker for 30s.
 */
export async function tableExists(table) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT to_regclass($1)::text AS reg`,
    `public.${table}`,
  );
  return Boolean(rows[0]?.reg);
}

/**
 * Check if a column exists on a table in the public schema.
 */
export async function columnExists(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    table, column
  );
  return rows.length > 0;
}

/**
 * Run a query. Spread-arg form for Prisma raw — passing the array as the
 * second arg makes it a phantom $1.
 */
export async function safeQuery(sql, params = [], label = 'query') {
  void label;
  return prisma.$queryRawUnsafe(sql, ...params);
}

/**
 * Fetch a single numeric scalar. `fallback` applies only to a successful query
 * with no usable value; database faults propagate to the request error path.
 */
export async function safeScalar(sql, params = [], fallback = 0) {
  const rows = await prisma.$queryRawUnsafe(sql, ...params);
  const v = rows[0] && Object.values(rows[0])[0];
  if (v === null || Number.isNaN(Number(v))) return fallback;
  return Number(v);
}

export default { tableExists, columnExists, safeQuery, safeScalar };
