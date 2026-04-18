import prisma from './prisma.js';

function returnsRows(sql) {
  return /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql);
}

export function createPrismaDb(client = prisma) {
  const run = async (sql, params = []) => {
    if (returnsRows(sql)) {
      const rows = await client.$queryRawUnsafe(sql, ...params);
      return { rows: Array.isArray(rows) ? rows : [] };
    }

    const rowCount = await client.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount: Number(rowCount) || 0 };
  };

  return {
    query: run,
    readQuery: run,
  };
}

export default createPrismaDb;
