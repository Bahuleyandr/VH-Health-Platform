import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(relativeUrl) {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

describe('production bootstrap and migration-writer ownership', () => {
  const wwwSource = read('../../bin/www.js');
  const jobSource = read('../../../../../infra/kubernetes/apps/backend/migration-job.yaml');
  const configSource = read('../../../../../infra/kubernetes/apps/backend/configmap.yaml');
  const trackerFenceMigration = read('../../migrations/735_migration_tracker_integrity_and_runtime_acl.sql');
  const prismaSource = read('../../lib/prisma.js');
  const runtimeGrantScript = read('../../../scripts/ensure-runtime-role-grants.mjs');
  const legacyInitDbPath = fileURLToPath(new URL('../../scripts/init-db.js', import.meta.url));
  const packageScripts = Object.values(JSON.parse(read('../../../package.json')).scripts);

  it('does not bind the HTTP socket until application bootstrap resolves', () => {
    const start = wwwSource.indexOf('prepareApplication()\n  .then(() => {');
    const listen = wwwSource.indexOf('server.listen(PORT)', start);
    expect(start).toBeGreaterThan(-1);
    expect(listen).toBeGreaterThan(start);
    expect(wwwSource.slice(0, start)).not.toContain('server.listen(PORT)');
    expect(wwwSource).not.toContain("from '../utils/scheduler.js'");
    expect(wwwSource.indexOf("await import('../utils/scheduler.js')")).toBeGreaterThan(
      wwwSource.indexOf('tenantRlsPostureMustFailClosed(rlsPosture)'),
    );
  });

  it('makes the owner PreSync job apply migrations and runtime grants in order', () => {
    const migrate = jobSource.indexOf('node scripts/ci-setup-db.mjs --skip-seeds');
    const grants = jobSource.indexOf('node scripts/ensure-runtime-role-grants.mjs');
    expect(migrate).toBeGreaterThan(-1);
    expect(grants).toBeGreaterThan(migrate);
    expect(configSource).toContain('RUN_MIGRATIONS: "false"');
  });

  it('keeps schema bootstrap authority in the migration runner', () => {
    expect(existsSync(legacyInitDbPath)).toBe(false);
    expect(packageScripts.join('\n')).not.toMatch(/\binit-db(?:\.js)?\b/);
  });

  it('keeps API roles read-only on the checksummed migration tracker', () => {
    expect(trackerFenceMigration).toContain("ARRAY['vhhealth_app', 'vhhealth_runtime']");
    expect(trackerFenceMigration).toContain('ALTER COLUMN checksum SET NOT NULL');
    expect(trackerFenceMigration).toContain("CHECK (checksum ~ '^[0-9a-f]{64}$')");
    expect(trackerFenceMigration).toContain('REVOKE ALL PRIVILEGES ON TABLE public._migrations');
    expect(trackerFenceMigration).toContain('GRANT SELECT ON TABLE public._migrations');

    const broadGrant = prismaSource.indexOf(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public',
    );
    const trackerFence = prismaSource.indexOf(
      'ON TABLE public._migrations\n          FROM ${role}',
      broadGrant,
    );
    expect(broadGrant).toBeGreaterThan(-1);
    expect(trackerFence).toBeGreaterThan(broadGrant);
    expect(runtimeGrantScript).toContain("'INSERT') AS runtime_tracker_insert");
    expect(runtimeGrantScript).toContain("'TRUNCATE') AS runtime_tracker_truncate");
    expect(runtimeGrantScript).toContain("'USAGE') AS runtime_tracker_sequence");
  });
});
