// Regression — admin DB-browser contype deserialization 500.
//
// databaseIntrospectionService.getTableDetail() selected pg_constraint.contype,
// which is Postgres's internal "char" type (oid 18). Prisma's $queryRawUnsafe
// deserializer cannot map that type and throws
//   "Failed to deserialize column of type 'char'".
// Because every table has at least a PRIMARY KEY constraint, this 500'd
// GET /api/v1/admin/database/tables/:table  AND  .../:table/rows for EVERY
// table — the admin route-crawl smoke caught it on abdm_care_contexts (the
// alphabetically-first table the DB browser loads). The fix casts contype::text.
//
// This pins the whole class: getTableDetail / getTableRows must resolve and the
// constraint `type` must come back as a plain string for core tables.

import prisma from '../lib/prisma.js';
import { getTableDetail, getTableRows } from '../services/databaseIntrospectionService.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

// Core tables guaranteed in every migrated DB; each has at least a PRIMARY KEY
// constraint, so the pg_constraint.contype path is exercised regardless of rows.
const SAMPLE_TABLES = ['users', 'admins', 'tenants'];

d('admin database introspection — contype deserialization regression', () => {
  afterAll(async () => {
    await prisma.$disconnect().catch(() => {});
  });

  it.each(SAMPLE_TABLES)(
    'getTableDetail(%s) returns constraints whose type is a plain string',
    async (table) => {
      const detail = await getTableDetail(table);
      expect(Array.isArray(detail.constraints)).toBe(true);
      expect(detail.constraints.length).toBeGreaterThan(0);
      for (const c of detail.constraints) {
        // contype must deserialize to a supported (string) type, not raw "char".
        expect(typeof c.type).toBe('string');
        expect(c.type.length).toBeGreaterThan(0);
      }
    }
  );

  it.each(SAMPLE_TABLES)(
    'getTableRows(%s) resolves without a deserialize error',
    async (table) => {
      const result = await getTableRows(table, { limit: 5 });
      expect(result.table.name).toBe(table);
      expect(Array.isArray(result.rows)).toBe(true);
      expect(Array.isArray(result.table.constraints)).toBe(true);
    }
  );
});
