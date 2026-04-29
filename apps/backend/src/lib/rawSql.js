/**
 * Narrow wrapper for legacy raw SQL call sites.
 *
 * New code should prefer Prisma models or tagged Prisma.sql queries. This
 * wrapper exists so remaining unsafe SQL has one visible choke point while the
 * older raw-query backlog is retired module by module.
 */
export async function rawQuery(client, sql, ...params) {
  return client.$queryRawUnsafe(sql, ...params);
}

export async function rawCommand(client, sql, ...params) {
  return client.$executeRawUnsafe(sql, ...params);
}

export function clampIntParam(value, { fallback, min = 1, max = 500 } = {}) {
  const parsed = Number.parseInt(value, 10);
  const base = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(base, min), max);
}
