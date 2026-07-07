import prisma from '../lib/prisma.js';

const DB_CONFIGURED = !!(process.env.DATABASE_URL || process.env.TEST_DATABASE_URL);
const d = DB_CONFIGURED ? describe : describe.skip;

const PREFIX = 'NL5TRGM';
const ROW_COUNT = 100_500;

function planContainsIndex(node, indexName) {
  if (!node || typeof node !== 'object') return false;
  if (node['Index Name'] === indexName) return true;
  for (const key of ['Plans', 'InitPlan', 'Subplans']) {
    if (Array.isArray(node[key]) && node[key].some((child) => planContainsIndex(child, indexName))) {
      return true;
    }
  }
  return false;
}

async function cleanup() {
  await prisma.$executeRawUnsafe(
    `DELETE FROM terminology_concepts WHERE system_key = 'SNOMED_CT' AND code LIKE $1`,
    `${PREFIX}%`,
  ).catch(() => {});
  await prisma.$executeRawUnsafe(
    `UPDATE terminology_code_systems
        SET concept_count = (SELECT COUNT(*) FROM terminology_concepts WHERE system_key = 'SNOMED_CT'),
            updated_at = NOW()
      WHERE system_key = 'SNOMED_CT'`,
  ).catch(() => {});
}

d('terminology search plan (NL-5 P1)', () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.$executeRawUnsafe(
      `INSERT INTO terminology_concepts (system_key, code, display, category, status, last_seen_release)
       SELECT
         'SNOMED_CT',
         $1 || g::text,
         CASE WHEN g = $2::int
              THEN 'NL5TRGM neonatal sepsis rare sentinel'
              ELSE 'NL5TRGM filler concept ' || g::text
          END,
         'nl5-trgm',
         'active',
         'NL5TRGM_TEST'
       FROM generate_series(1, $2::int) AS g
       ON CONFLICT (system_key, code) DO UPDATE SET
         display = EXCLUDED.display,
         status = 'active',
         last_seen_release = EXCLUDED.last_seen_release,
         updated_at = NOW()`,
      PREFIX,
      ROW_COUNT,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE terminology_code_systems
          SET concept_count = (SELECT COUNT(*) FROM terminology_concepts WHERE system_key = 'SNOMED_CT'),
              updated_at = NOW()
        WHERE system_key = 'SNOMED_CT'`,
    );
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect().catch(() => {});
  }, 120_000);

  test('substring search uses the pg_trgm GIN index on a 100k-row synthetic corpus', async () => {
    const index = await prisma.$queryRawUnsafe(
      `SELECT to_regclass('public.idx_terminology_concepts_display_trgm')::text AS index_name`,
    );
    expect(index[0]?.index_name).toBe('idx_terminology_concepts_display_trgm');

    const planRows = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
      return tx.$queryRawUnsafe(
        `EXPLAIN (FORMAT JSON)
         SELECT code, display
           FROM terminology_concepts
          WHERE lower(display) LIKE '%neonatal%'
          LIMIT 12`,
      );
    });
    const plan = planRows[0]['QUERY PLAN'][0].Plan;
    expect(planContainsIndex(plan, 'idx_terminology_concepts_display_trgm')).toBe(true);
  }, 120_000);
});
