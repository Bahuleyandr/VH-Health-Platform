// Audit 2026-06-18 §3 (Data layer, HIGH) — float money columns -> numeric.
//
// medications.price and investigation_template_tests.cost were `double
// precision` (binary float). Both flow into billing (pharmacy line items /
// investigation charges), so storing currency as IEEE-754 float means values
// like 0.10 + 0.20 don't round-trip exactly and accumulated charges drift by
// fractions of a paisa — unacceptable on a money path. Migration 323 converts
// both to numeric(12,2) with a value-preserving cast rounded to paise.
//
// These tests prove:
//   1. both columns report data_type 'numeric' with precision 12 / scale 2
//   2. a representative price/cost inserted round-trips EXACTLY (no float drift)
//   3. a classic float-drift trap value (0.1 + 0.2 style) is stored/returned as
//      an exact decimal, and a value with >2 fractional digits is rounded to
//      paise by the column scale rather than retaining binary-float tails
//
// Self-isolating fixtures (rows with sentinel names, cleaned up). Needs the
// test Postgres; self-skips when unconfigured.

import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const MED_NAME = '__numtest_med_323__';
const TEST_NAME = '__numtest_invtest_323__';

async function cleanup() {
  await prisma.$executeRawUnsafe(`DELETE FROM medications WHERE name = $1`, MED_NAME).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM investigation_template_tests WHERE test_name = $1`, TEST_NAME).catch(() => {});
}

async function columnType(table, column) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_name = $1 AND column_name = $2`,
    table, column,
  );
  return rows[0];
}

d('money columns are numeric, not float (migration 323)', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  });

  test('the migration is recorded in the tracker', async () => {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT 1 FROM _migrations WHERE name = $1 LIMIT 1`,
      '323_money_column_numeric.sql',
    );
    expect(rows.length).toBe(1);
  });

  test('medications.price is numeric(12,2)', async () => {
    const t = await columnType('medications', 'price');
    expect(t.data_type).toBe('numeric');
    expect(Number(t.numeric_precision)).toBe(12);
    expect(Number(t.numeric_scale)).toBe(2);
  });

  test('investigation_template_tests.cost is numeric(12,2)', async () => {
    const t = await columnType('investigation_template_tests', 'cost');
    expect(t.data_type).toBe('numeric');
    expect(Number(t.numeric_precision)).toBe(12);
    expect(Number(t.numeric_scale)).toBe(2);
  });

  test('medications.price round-trips an exact decimal with no float drift', async () => {
    // 1234567.89 would be unrepresentable cleanly as a float tail; numeric is exact.
    const ins = await prisma.$queryRawUnsafe(
      `INSERT INTO medications (name, price, is_active)
         VALUES ($1, 1234567.89, true)
       RETURNING price::text AS price_text`,
      MED_NAME,
    );
    expect(ins[0].price_text).toBe('1234567.89');

    const read = await prisma.$queryRawUnsafe(
      `SELECT price::text AS price_text FROM medications WHERE name = $1`,
      MED_NAME,
    );
    expect(read[0].price_text).toBe('1234567.89');
  });

  test('investigation_template_tests.cost round-trips an exact decimal with no float drift', async () => {
    const ins = await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_template_tests (test_name, cost)
         VALUES ($1, 999.99)
       RETURNING cost::text AS cost_text`,
      TEST_NAME,
    );
    expect(ins[0].cost_text).toBe('999.99');

    const read = await prisma.$queryRawUnsafe(
      `SELECT cost::text AS cost_text FROM investigation_template_tests WHERE test_name = $1`,
      TEST_NAME,
    );
    expect(read[0].cost_text).toBe('999.99');
  });

  test('the float-drift trap (0.1 + 0.2) sums exactly under numeric arithmetic', async () => {
    // Under double precision, 0.1 + 0.2 = 0.30000000000000004. As numeric it is
    // exactly 0.30. Store 0.10 and 0.20 in the column, sum in SQL, expect 0.30.
    // Isolate from other tests that reuse MED_NAME (e.g. the round-trip test).
    await prisma.$executeRawUnsafe(`DELETE FROM medications WHERE name = $1`, MED_NAME);
    await prisma.$executeRawUnsafe(
      `INSERT INTO medications (name, price, is_active) VALUES ($1, 0.10, true)`,
      MED_NAME,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO medications (name, price, is_active) VALUES ($1, 0.20, true)`,
      MED_NAME,
    );
    const sum = await prisma.$queryRawUnsafe(
      `SELECT SUM(price)::text AS total FROM medications WHERE name = $1`,
      MED_NAME,
    );
    expect(sum[0].total).toBe('0.30');
  });

  test('a value with >2 fractional digits is stored rounded to paise (scale 2), not as a float tail', async () => {
    // 10.005 -> numeric(12,2) rounds half-away-from-zero to 10.01 (deterministic),
    // never 10.004999999... as a float would surface.
    const ins = await prisma.$queryRawUnsafe(
      `INSERT INTO investigation_template_tests (test_name, cost)
         VALUES ($1, 10.005)
       RETURNING cost::text AS cost_text`,
      TEST_NAME,
    );
    expect(ins[0].cost_text).toBe('10.01');
  });
});
