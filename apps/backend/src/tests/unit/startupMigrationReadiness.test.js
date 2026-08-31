import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function read(relativeUrl) {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), 'utf8');
}

describe('production bootstrap and migration-writer ownership', () => {
  const wwwSource = read('../../bin/www.js');
  const jobSource = read('../../../../../infra/kubernetes/apps/backend/migration-job.yaml');
  const configSource = read('../../../../../infra/kubernetes/apps/backend/configmap.yaml');
  const payrollAcceptanceSource = read(
    '../../../../../infra/kubernetes/apps/backend/payroll-revision-754-acceptance.yaml',
  );
  const backendKustomizationSource = read(
    '../../../../../infra/kubernetes/apps/backend/kustomization.yaml',
  );
  const productionAppsKustomizationSource = read(
    '../../../../../infra/kubernetes/apps/kustomization.yaml',
  );
  const stagingAppsKustomizationSource = read(
    '../../../../../infra/kubernetes/overlays/staging/apps/kustomization.yaml',
  );
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
    const payrollPreflight = jobSource.indexOf(
      'node scripts/payroll-revision-754-preflight.mjs --report-only',
    );
    const migrate = jobSource.indexOf('node scripts/ci-setup-db.mjs --skip-seeds');
    const grants = jobSource.indexOf('node scripts/ensure-runtime-role-grants.mjs');
    expect(payrollPreflight).toBeGreaterThan(-1);
    expect(migrate).toBeGreaterThan(payrollPreflight);
    expect(migrate).toBeGreaterThan(-1);
    expect(grants).toBeGreaterThan(migrate);
    expect(configSource).toContain('RUN_MIGRATIONS: "false"');
    expect(backendKustomizationSource).toContain('payroll-revision-754-acceptance.yaml');
    expect(payrollAcceptanceSource).toContain('argocd.argoproj.io/hook: PreSync');
    expect(payrollAcceptanceSource).toContain('argocd.argoproj.io/sync-wave: "-2"');
    expect(payrollAcceptanceSource).toContain(
      'argocd.argoproj.io/hook-delete-policy: BeforeHookCreation',
    );
    expect(jobSource).toContain('argocd.argoproj.io/sync-wave: "-1"');
    expect(jobSource).toContain('name: vhhealth-payroll-revision-754-acceptance');
    expect(jobSource).toMatch(
      /name: PAYROLL_754_ACCEPTED_MANIFEST_SHA256[\s\S]*?configMapKeyRef:[\s\S]*?name: vhhealth-payroll-revision-754-acceptance[\s\S]*?key: PAYROLL_754_ACCEPTED_MANIFEST_SHA256/,
    );
    expect(jobSource).toMatch(
      /name: PAYROLL_754_ACCEPTED_BY[\s\S]*?configMapKeyRef:[\s\S]*?name: vhhealth-payroll-revision-754-acceptance[\s\S]*?key: PAYROLL_754_ACCEPTED_BY/,
    );
    expect(payrollAcceptanceSource).toContain(
      'PAYROLL_754_ACCEPTED_MANIFEST_SHA256: ""',
    );
    expect(payrollAcceptanceSource).toContain('PAYROLL_754_ACCEPTED_BY: ""');
    expect(configSource).not.toContain('PAYROLL_754_ACCEPTED_MANIFEST_SHA256');
    expect(configSource).not.toContain('PAYROLL_754_ACCEPTED_BY');
    for (const environmentPatch of [
      productionAppsKustomizationSource,
      stagingAppsKustomizationSource,
    ]) {
      expect(environmentPatch).toContain('name: vhhealth-payroll-revision-754-acceptance');
      expect(environmentPatch).toContain('PAYROLL_754_ACCEPTED_MANIFEST_SHA256: ""');
      expect(environmentPatch).toContain('PAYROLL_754_ACCEPTED_BY: ""');
    }
  });

  it('tolerates a missing runtime role only on explicit opt-in, which the PreSync job never grants', () => {
    // The grants pass may treat exactly the configuration-absent skip as a
    // loud no-op, and only when the environment opted in (single-DSN rigs).
    expect(runtimeGrantScript).toContain("result.reason === 'no_runtime_role_configured'");
    expect(runtimeGrantScript).toContain("process.env.RUNTIME_ROLE_GRANTS_OPTIONAL === 'true'");
    // Everything else — unsafe role name, grant error, bad posture — must
    // still fail regardless of the knob.
    expect(runtimeGrantScript).toContain('runtime role grant pass skipped');
    expect(runtimeGrantScript).toContain('runtime roles are absent, unsafe, or have write access');
    // The canonical PreSync Job and the prod config never SET the knob (a
    // documenting comment is fine, a live env entry is not): production keeps
    // failing closed if the configmap ever loses AUTH_TENANT_RLS_RUNTIME_ROLE.
    expect(jobSource).not.toMatch(/name:\s*['"]?RUNTIME_ROLE_GRANTS_OPTIONAL/);
    expect(configSource).not.toMatch(/^\s*RUNTIME_ROLE_GRANTS_OPTIONAL:/m);
    expect(configSource).toContain('AUTH_TENANT_RLS_RUNTIME_ROLE');
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
