// src/lib/prismaCompat.js
//
// Thin pg-style shim ({rows, rowCount}) over the Prisma raw-SQL surface.
// Lets legacy sites that expect DatabaseManager's return shape work against
// the Prisma client without rewriting callers.
//
// `query`       → uses the primary client (writes + consistent reads)
// `readQuery`   → uses the read replica when DATABASE_READ_URL is set,
//                 falling back to the primary otherwise.
//
// The underlying Prisma instances are hardened (circuit breaker, slow-query
// logging, etc.) by src/lib/prisma.js — this shim inherits all of that.

import prisma, { prismaReadOnly } from './prisma.js';

function returnsRows(sql) {
  return /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

function runner(client) {
  return async (sql, params = []) => {
    if (returnsRows(sql)) {
      const rows = await client.$queryRawUnsafe(sql, ...params);
      return { rows: Array.isArray(rows) ? rows : [] };
    }
    const rowCount = await client.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount: Number(rowCount) || 0 };
  };
}

export function createPrismaDb(client = prisma, readClient = prismaReadOnly) {
  return {
    query: runner(client),
    readQuery: runner(readClient),
  };
}

export default createPrismaDb;
