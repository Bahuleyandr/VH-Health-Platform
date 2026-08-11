import { existsSync, readFileSync } from 'node:fs';

const deadSources = [
  '../../controllers/pharmacyController.js',
  '../../utils/auth/tokenHelpers.js',
  '../../services/investigation/templateService.js',
  '../../services/analytics/execDigestBenchmarkService.js',
];

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Audit 3 dead-surface guard', () => {
  it.each(deadSources)('keeps %s retired', (path) => {
    expect(existsSync(new URL(path, import.meta.url))).toBe(false);
  });

  it('keeps the orphaned executive digest service test retired', () => {
    expect(existsSync(new URL('./execDigestBenchmarkService.test.js', import.meta.url))).toBe(false);
  });

  it('keeps the governed pharmacy order controller on the live router', () => {
    const route = read('../../routes/pharmacy/index.js');

    expect(route).toContain("../../controllers/pharmacy/pharmacyOrderController.js");
    expect(route).not.toContain("../../controllers/pharmacyController.js");
  });

  it('retires the deploy-held executive digest data surfaces', () => {
    const migration = read('../../migrations/660_retire_exec_digest_benchmark_pack.sql');
    const schema = read('../../../prisma/schema.prisma');
    const tables = [
      'analytics_exec_digest_settings',
      'analytics_exec_digest_subscriptions',
      'analytics_exec_digest_deliveries',
      'analytics_benchmark_pack_exports',
    ];
    const firstDrop = migration.indexOf('DROP TABLE');
    const preflightEnd = migration.indexOf('END $$;');

    expect(migration).not.toContain('@no-transaction');
    expect(migration).not.toMatch(/\bCASCADE\b/i);
    expect(migration).toContain("SET LOCAL lock_timeout = '10s';");
    expect(migration).toContain("SET LOCAL statement_timeout = '30s';");
    expect(migration).toContain('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE');
    expect(migration).toContain('SELECT EXISTS (SELECT 1 FROM public.%I LIMIT 1)');
    expect(migration).toContain("ERRCODE = 'P10D1'");
    expect(migration).toContain('AUDIT3_P10_DEAD_SURFACE_DATA_PRESENT');
    expect(preflightEnd).toBeGreaterThan(-1);
    expect(firstDrop).toBeGreaterThan(preflightEnd);

    for (const table of tables) {
      expect(migration).toContain(`'${table}'`);
      expect(migration).toContain(`DROP TABLE IF EXISTS ${table};`);
      expect(schema).not.toContain(`model ${table} {`);
    }
  });

  it('preserves investigation template schema and migration history', () => {
    const baseline = read('../../migrations/000_baseline.sql');
    const driftMigration = read('../../migrations/088_drift_sweep_missing_columns.sql');
    const schema = read('../../../prisma/schema.prisma');

    expect(baseline).toContain('CREATE TABLE public.investigation_templates');
    expect(baseline).toContain('CREATE TABLE public.investigation_template_tests');
    expect(driftMigration).toContain('-- Writers: services/investigation/templateService.js:150/186');
    expect(driftMigration).toContain('-- Writers: services/investigation/templateService.js:91');
    expect(schema).toContain('model investigation_templates {');
    expect(schema).toContain('model investigation_template_tests {');
  });
});
