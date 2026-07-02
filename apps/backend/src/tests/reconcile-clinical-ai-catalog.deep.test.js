import pg from 'pg';

import {
  quoteIdentifier,
  reconcileClinicalAiCatalog,
} from '../../scripts/reconcile-clinical-ai-catalog.mjs';

const connectionString = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL;
const TABLE_NAME = `clinical_ai_modules_reconcile_fixture_${process.pid}`;

describe('reconcile-clinical-ai-catalog operator script', () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString });
    await client.connect();
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP TABLE IF EXISTS ${quoteIdentifier(TABLE_NAME)}`).catch(() => {});
      await client.end().catch(() => {});
    }
  });

  beforeEach(async () => {
    await client.query(`DROP TABLE IF EXISTS ${quoteIdentifier(TABLE_NAME)}`);
    await client.query(
      `CREATE TABLE ${quoteIdentifier(TABLE_NAME)} (
        module_key VARCHAR(80),
        display_name VARCHAR(160),
        enabled BOOLEAN NOT NULL DEFAULT false,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`,
    );
    await client.query(
      `INSERT INTO ${quoteIdentifier(TABLE_NAME)}
         (module_key, display_name, enabled, created_at, updated_at)
       VALUES
         ('dupe_alpha', 'Alpha old', false, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
         ('dupe_alpha', 'Alpha newest', true, NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 hour'),
         ('dupe_beta', 'Beta old', true, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),
         ('dupe_beta', 'Beta newest', false, NOW() - INTERVAL '1 day', NOW() - INTERVAL '10 minutes'),
         ('single_gamma', 'Gamma single', true, NOW(), NOW())`,
    );
  });

  it('dry-runs duplicate detection without deleting fixture rows', async () => {
    const report = await reconcileClinicalAiCatalog(client, {
      apply: false,
      tableName: TABLE_NAME,
      ensureConstraint: false,
    });

    expect(report.mode).toBe('dry-run');
    expect(report.duplicate_module_keys).toBe(2);
    expect(report.rows_to_delete).toBe(2);
    expect(report.deleted_rows).toHaveLength(0);
    expect(report.duplicate_groups.find((group) => group.module_key === 'dupe_alpha').keep.display_name)
      .toBe('Alpha newest');

    const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${quoteIdentifier(TABLE_NAME)}`);
    expect(rows[0].count).toBe(5);
  });

  it('deletes stale duplicates and keeps the newest-updated row per module_key', async () => {
    const report = await reconcileClinicalAiCatalog(client, {
      apply: true,
      tableName: TABLE_NAME,
      ensureConstraint: false,
    });

    expect(report.mode).toBe('apply');
    expect(report.deleted_rows).toHaveLength(2);

    const { rows: duplicateRows } = await client.query(
      `SELECT module_key, COUNT(*)::int AS count
         FROM ${quoteIdentifier(TABLE_NAME)}
        GROUP BY module_key
       HAVING COUNT(*) > 1`,
    );
    expect(duplicateRows).toHaveLength(0);

    const { rows } = await client.query(
      `SELECT module_key, display_name, enabled
         FROM ${quoteIdentifier(TABLE_NAME)}
        ORDER BY module_key`,
    );
    expect(rows).toEqual([
      { module_key: 'dupe_alpha', display_name: 'Alpha newest', enabled: true },
      { module_key: 'dupe_beta', display_name: 'Beta newest', enabled: false },
      { module_key: 'single_gamma', display_name: 'Gamma single', enabled: true },
    ]);
  });
});
