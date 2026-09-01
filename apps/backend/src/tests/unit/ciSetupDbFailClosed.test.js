import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';
import pg from 'pg';

import {
  assertMigrationBatchSucceeded,
  assertMigrationTrackerReady,
} from '../../../scripts/lib/migrationBatchGuard.mjs';
import {
  assertCiSetupSeedPolicy,
  assertSyntheticSeedTarget,
} from '../../../scripts/lib/testDataSeedGuard.mjs';
import { MIGRATION_SESSION_GUCS } from '../../../scripts/lib/migrationSessionGucs.mjs';

const runnerSource = readFileSync(
  new URL('../../../scripts/ci-setup-db.mjs', import.meta.url),
  'utf8',
);
const migrationJobSource = readFileSync(
  new URL('../../../../../infra/kubernetes/apps/backend/migration-job.yaml', import.meta.url),
  'utf8',
);
const payrollRevisionPreflightSource = readFileSync(
  new URL('../../../scripts/payroll-revision-754-preflight.mjs', import.meta.url),
  'utf8',
);
const backendWorkflowSource = readFileSync(
  new URL('../../../../../.github/workflows/_reusable-backend-lint-test.yml', import.meta.url),
  'utf8',
);

const directSeedSources = [
  'seed-clinical-ai-preflight-reviewers.mjs',
  'seed-comprehensive-test-data.mjs',
  'seed-current-bed-structure.mjs',
  'seed-departments-doctors-local.mjs',
  'seed-icd10-local.mjs',
  'seed-smoke-admin-totp.mjs',
  'seed-sprint-fixtures.mjs',
  'seed-test-staff-accounts.mjs',
].map((name) => ({
  name,
  source: readFileSync(new URL(`../../../scripts/${name}`, import.meta.url), 'utf8'),
}));

const rootLocalToolSources = ['seed-dev-env.mjs'].map((name) => ({
  name,
  source: readFileSync(new URL(`../../../../../scripts/${name}`, import.meta.url), 'utf8'),
}));

const localHandsOnSeedSource = readFileSync(
  new URL('../../../../../scripts/seed-local-hands-on-hospital-data.mjs', import.meta.url),
  'utf8',
);

const qaTenantSeedSource = readFileSync(
  new URL('../../../../../scripts/seed-qa-tenant.mjs', import.meta.url),
  'utf8',
);

describe('ci-setup-db migration failure boundary', () => {
  test('throws after closing the client so seed execution cannot continue', async () => {
    const events = [];
    const client = {
      end: jest.fn(async () => {
        events.push('client-ended');
      }),
    };
    const logger = {
      error: jest.fn(message => {
        events.push(`logged:${message}`);
      }),
    };

    const setup = async () => {
      await assertMigrationBatchSucceeded({ errors: 2, client, logger });
      events.push('seed-ran');
    };

    await expect(setup()).rejects.toThrow(
      'Migration setup failed: 2 migration(s) failed; seeds and RLS test-role provisioning were not run.',
    );
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'logged:Migration setup failed: 2 migration(s) failed; seeds and RLS test-role provisioning were not run.',
      'client-ended',
    ]);
  });

  test('names the failing migrations so a muted-logger run is still diagnosable', async () => {
    const client = { end: jest.fn() };
    const logger = { error: jest.fn() };

    await expect(
      assertMigrationBatchSucceeded({
        errors: 1,
        failedFiles: ['759_fix_escalation_snapshot_guard_case.sql'],
        client,
        logger,
      }),
    ).rejects.toThrow(
      'Migration setup failed: 1 migration(s) failed (759_fix_escalation_snapshot_guard_case.sql); '
        + 'seeds and RLS test-role provisioning were not run.',
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('759_fix_escalation_snapshot_guard_case.sql'),
    );
  });

  test('returns without closing the client when every migration succeeded', async () => {
    const client = { end: jest.fn() };
    const logger = { error: jest.fn() };

    await expect(
      assertMigrationBatchSucceeded({ errors: 0, client, logger }),
    ).resolves.toBeUndefined();
    expect(client.end).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('rejects canonical schema with missing migration history before setup can continue', async () => {
    const events = [];
    const client = { end: jest.fn(async () => events.push('client-ended')) };
    const logger = { error: jest.fn(() => events.push('blocked')) };

    const setup = async () => {
      await assertMigrationTrackerReady({
        canonicalBaselinePresent: true,
        trackerTablePresent: true,
        baselineTracked: false,
        baselineFile: '000_baseline.sql',
        client,
        logger,
      });
      events.push('migration-ran');
    };

    await expect(setup()).rejects.toThrow(
      'canonical baseline schema exists but _migrations does not record 000_baseline.sql',
    );
    expect(events).toEqual(['blocked', 'client-ended']);
  });

  test('accepts fresh empty schema and canonical schema with verified baseline history', async () => {
    const client = { end: jest.fn() };
    const logger = { error: jest.fn() };
    const common = { baselineFile: '000_baseline.sql', client, logger };

    await expect(assertMigrationTrackerReady({
      ...common,
      canonicalBaselinePresent: false,
      trackerTablePresent: false,
      baselineTracked: false,
    })).resolves.toBeUndefined();
    await expect(assertMigrationTrackerReady({
      ...common,
      canonicalBaselinePresent: true,
      trackerTablePresent: true,
      baselineTracked: true,
    })).resolves.toBeUndefined();
    expect(client.end).not.toHaveBeenCalled();
  });

  test('stops after collecting migration errors and before any seed or role provisioning', () => {
    const migrationLoop = runnerSource.indexOf('for (const file of files)');
    const fatalGuard = runnerSource.indexOf(
      'await assertMigrationBatchSucceeded({ errors, failedFiles, client, logger })',
      migrationLoop,
    );
    const seedBoundary = runnerSource.indexOf('// Seed minimal lookup data', migrationLoop);
    const roleBoundary = runnerSource.indexOf('// Provision the non-owner RLS test roles', migrationLoop);

    expect(migrationLoop).toBeGreaterThan(-1);
    expect(fatalGuard).toBeGreaterThan(migrationLoop);
    expect(seedBoundary).toBeGreaterThan(fatalGuard);
    expect(roleBoundary).toBeGreaterThan(seedBoundary);
  });

  test('delegates migration execution, stops on failure, and keeps explicit skips non-fatal', () => {
    const skipBranch = runnerSource.indexOf('if (SKIP_MIGRATIONS.has(file))');
    const skipContinue = runnerSource.indexOf('continue;', skipBranch);
    const migrationTry = runnerSource.indexOf('try {', skipBranch);
    const executorCall = runnerSource.indexOf(
      'const result = await executeCiMigrationFile({',
      migrationTry,
    );
    const errorIncrement = runnerSource.indexOf('errors++;', migrationTry);
    const failureBreak = runnerSource.indexOf('break;', errorIncrement);

    expect(skipBranch).toBeGreaterThan(-1);
    expect(skipContinue).toBeGreaterThan(skipBranch);
    expect(migrationTry).toBeGreaterThan(skipContinue);
    expect(executorCall).toBeGreaterThan(migrationTry);
    expect(errorIncrement).toBeGreaterThan(executorCall);
    expect(failureBreak).toBeGreaterThan(errorIncrement);
  });

  test('restores plpgsql body checking after every migration so a relaxation cannot leak', () => {
    // 000_baseline.sql and 758 both issue a SESSION-level
    // `SET check_function_bodies = false` so they can create functions ahead of
    // the tables those functions reference. Every migration is applied through
    // ONE long-lived client, so without an explicit restore that relaxation
    // outlives the file that asked for it and every later migration is applied
    // unvalidated. That is exactly how 744 and 745 shipped plpgsql bodies which
    // cannot compile (a bare CASE inside an IF condition eats the IF's THEN)
    // while CI stayed green; plpgsql compiles lazily, so both trigger functions
    // would have raised the first time they fired.
    // The mechanism was generalised after this test was written: the runner no
    // longer restores one parameter by name, it pins the whole set it owns from
    // scripts/lib/migrationSessionGucs.mjs (check_function_bodies = on,
    // row_security = off, client_min_messages = notice). The invariant this
    // test exists for is unchanged, so it is re-pointed rather than deleted.
    //
    // Assert the VALUE from the shared table rather than a literal in the runner
    // source: how the SET is spelled is an implementation detail, but what the
    // session ends up with is the thing that must not regress.
    expect(MIGRATION_SESSION_GUCS.check_function_bodies).toBe('on');

    const migrationLoop = runnerSource.indexOf('for (const file of files)');
    const executorCall = runnerSource.indexOf(
      'const result = await executeCiMigrationFile({',
      migrationLoop,
    );
    const pinCall = runnerSource.indexOf('await pinMigrationSessionGucs(client);', executorCall);
    const appliedAdd = runnerSource.indexOf('applied.add(file);', executorCall);

    // Pinned once BEFORE the first migration, so the invariant does not depend
    // on the baseline's pg_dump preamble happening to supply the right values.
    const preLoopPin = runnerSource.indexOf('await pinMigrationSessionGucs(client);');
    expect(preLoopPin).toBeGreaterThan(-1);
    expect(preLoopPin).toBeLessThan(migrationLoop);

    // And again INSIDE the per-file loop, after the file is applied and before
    // the next iteration — not once after the whole batch.
    expect(pinCall).toBeGreaterThan(executorCall);
    expect(pinCall).toBeLessThan(appliedAdd);

    // A leak that survives to the end of the chain fails the run rather than
    // being reported only by a unit test that a skipped tier can hide.
    const postChainAssert = runnerSource.indexOf('await assertMigrationSessionGucs();');
    expect(postChainAssert).toBeGreaterThan(appliedAdd);
  });

  test('only the two known-uncompilable migrations are applied with body checking off', () => {
    // 744 and 745 shipped plpgsql bodies that cannot compile. 759 repairs the
    // functions, but it runs AFTER them, so a fresh database must still replay
    // 744 and 745 on the way there — they are applied exactly as they always
    // were, with checking off, and validation is restored immediately after.
    // Amending them instead would drift their recorded checksum in every
    // environment that has already applied them.
    //
    // Pinned exactly: this set must never grow. A new migration whose bodies do
    // not compile is a bug to fix before merge, not an entry here.
    const setStart = runnerSource.indexOf('const BODIES_KNOWN_UNCOMPILABLE = new Set([');
    expect(setStart).toBeGreaterThan(-1);
    const setEnd = runnerSource.indexOf(']);', setStart);
    const listed = runnerSource
      .slice(setStart, setEnd)
      .match(/'[^']+\.sql'/g)
      ?.map((s) => s.slice(1, -1)) ?? [];
    expect(listed.sort()).toEqual([
      '744_medication_inventory_billing_mar_closure.sql',
      '745_clinical_alert_delivery_obligations.sql',
    ]);

    // The relaxation must be applied BEFORE the file executes, and must be
    // reachable from inside the loop rather than left defined and unused.
    const migrationLoop = runnerSource.indexOf('for (const file of files)');
    const relaxCall = runnerSource.indexOf('await relaxFunctionBodyCheckingFor(file);', migrationLoop);
    const executorCall = runnerSource.indexOf(
      'const result = await executeCiMigrationFile({',
      migrationLoop,
    );
    expect(relaxCall).toBeGreaterThan(migrationLoop);
    expect(relaxCall).toBeLessThan(executorCall);
  });

  test('adopts legacy checksums before apply and verifies the exact tracker before seeds', () => {
    const trackerGuard = runnerSource.indexOf('await assertMigrationTrackerReady({');
    const checksumColumn = runnerSource.indexOf(
      'await client.query(ENSURE_MIGRATION_CHECKSUM_COLUMN_SQL)',
      trackerGuard,
    );
    const adoption = runnerSource.indexOf(
      'await reconcileExistingTrackerChecksums()',
      checksumColumn,
    );
    const migrationLoop = runnerSource.indexOf('for (const file of files)', adoption);
    const finalVerification = runnerSource.indexOf(
      'await assertTrackerChecksumsCurrent()',
      migrationLoop,
    );
    const seedBoundary = runnerSource.indexOf('// Seed minimal lookup data', finalVerification);

    expect(checksumColumn).toBeGreaterThan(trackerGuard);
    expect(adoption).toBeGreaterThan(checksumColumn);
    expect(migrationLoop).toBeGreaterThan(adoption);
    expect(finalVerification).toBeGreaterThan(migrationLoop);
    expect(seedBoundary).toBeGreaterThan(finalVerification);
  });

  test('the migration smoke rejects a baseline schema with missing history without mutation', () => {
    const smokeSource = readFileSync(
      new URL('../../../scripts/smoke-migration-runner.mjs', import.meta.url),
      'utf8',
    );

    expect(smokeSource).toContain('async function createUntrackedBaselineDb()');
    expect(smokeSource).toContain(
      "readFileSync(join(migrationsDir, '000_baseline.sql'), 'utf8')",
    );
    expect(smokeSource).toContain(
      'missing tracker rejected before migration or seed mutation',
    );
  });
});

describe('migrated-template cache integrity', () => {
  test('hashes every migration-execution semantic dependency root', () => {
    const keyLine = backendWorkflowSource
      .split('\n')
      .find((line) => line.includes('key: db-template-v3-'));

    expect(keyLine).toContain('${{ runner.os }}-node-26.5.0-${{ inputs.postgres_image }}');
    for (const input of [
      '.github/workflows/_reusable-backend-lint-test.yml',
      'apps/backend/src/migrations/**',
      'apps/backend/scripts/ci-setup-db.mjs',
      'apps/backend/scripts/ensure-pgvector-extension.mjs',
      'apps/backend/scripts/lib/**',
      'apps/backend/src/utils/migrations/**',
      'apps/backend/src/logging/**',
      'apps/backend/src/utils/logMasking.js',
      'apps/backend/src/utils/urlRedaction.js',
      'apps/backend/package.json',
      'apps/backend/package-lock.json',
    ]) {
      expect(keyLine).toContain(`'${input}'`);
    }
  });
});

describe('test-data seed safety boundary', () => {
  test('production setup refuses seeds even when the non-test override is present', () => {
    const env = {
      NODE_ENV: 'production',
      VH_ALLOW_NON_TEST_DATA_SEED: 'true',
    };

    expect(() => assertCiSetupSeedPolicy({
      skipSeedsArg: false,
      skipSeedsEnv: false,
      env,
    })).toThrow(
      'Production database setup requires --skip-seeds and CI_DB_SKIP_SEEDS=1',
    );
    expect(() => assertSyntheticSeedTarget({
      connectionString: 'postgresql://postgres@127.0.0.1:5432/vhhealth_test',
      env,
      scriptName: 'seed-test-staff-accounts.mjs',
    })).toThrow('refuses synthetic data when NODE_ENV=production');
  });

  test('production setup accepts only the explicit seed-free path', () => {
    expect(() => assertCiSetupSeedPolicy({
      skipSeedsArg: true,
      skipSeedsEnv: true,
      env: { NODE_ENV: 'production', CI_DB_SKIP_SEEDS: '1' },
    })).not.toThrow();
  });

  test('direct seeds require a local vhhealth_test database or a non-production override', () => {
    expect(() => assertSyntheticSeedTarget({
      connectionString: 'postgresql://postgres@localhost:5432/vhhealth_test',
      env: { NODE_ENV: 'test' },
      scriptName: 'seed-test-staff-accounts.mjs',
    })).not.toThrow();

    expect(() => assertSyntheticSeedTarget({
      connectionString: 'postgresql://postgres@db.internal:5432/vhhealth',
      env: { NODE_ENV: 'development' },
      scriptName: 'seed-test-staff-accounts.mjs',
    })).toThrow('requires local vhhealth_test');

    expect(() => assertSyntheticSeedTarget({
      connectionString: 'postgresql://postgres@db.internal:5432/vhhealth_ci?schema=public&sslmode=require',
      env: {
        NODE_ENV: 'test',
        VH_ALLOW_NON_TEST_DATA_SEED: 'true',
      },
      scriptName: 'seed-test-staff-accounts.mjs',
    })).not.toThrow();

    expect(() => assertSyntheticSeedTarget({
      connectionString: 'postgresql://postgres@localhost:5432/vhhealth_test?host=prod-db',
      env: {
        NODE_ENV: 'test',
        VH_ALLOW_NON_TEST_DATA_SEED: 'true',
      },
      scriptName: 'seed-test-staff-accounts.mjs',
    })).toThrow('must not use connection-target query parameters');

    expect(() => assertSyntheticSeedTarget({
      connectionString: 'not a postgres URL',
      env: {
        NODE_ENV: 'test',
        VH_ALLOW_NON_TEST_DATA_SEED: 'true',
      },
      scriptName: 'seed-test-staff-accounts.mjs',
    })).toThrow('requires a valid PostgreSQL connection URL');
  });

  test('QA seed targets require an exact PostgreSQL loopback host and QA database name', () => {
    const qaSeedOptions = {
      env: { NODE_ENV: 'qa' },
      scriptName: 'seed-qa-tenant.mjs',
      allowedDatabaseNames: ['vhhealth_test', 'vhhealth_qa'],
      allowNonTestOverride: false,
    };

    for (const connectionString of [
      'postgresql://qa_writer@127.0.0.1:55432/vhhealth_test',
      'postgres://qa_writer@localhost:55432/vhhealth_qa',
      'postgresql://qa_writer@[::1]:55432/vhhealth_test',
    ]) {
      expect(() => assertSyntheticSeedTarget({
        ...qaSeedOptions,
        connectionString,
      })).not.toThrow();
    }

    const misleadingUserinfoTarget = [
      'postgresql://',
      ['local', 'host'].join(''),
      ':',
      ['vhhealth', '_test'].join(''),
      '@db.internal:5432/vhhealth',
    ].join('');

    for (const connectionString of [
      misleadingUserinfoTarget,
      'postgresql://qa_writer@localhost:55432/vhhealth_test_backup',
    ]) {
      expect(() => assertSyntheticSeedTarget({
        ...qaSeedOptions,
        connectionString,
      })).toThrow('requires local vhhealth_test or vhhealth_qa');
    }

    for (const connectionString of [
      'https://localhost/vhhealth_test',
      'not a postgres URL',
      'postgresql://qa_writer@localhost:55432/vhhealth_test ',
    ]) {
      expect(() => assertSyntheticSeedTarget({
        ...qaSeedOptions,
        connectionString,
      })).toThrow('requires a valid PostgreSQL connection URL');
    }

    const hostOverride = 'postgresql://qa_writer@localhost:55432/vhhealth_test?host=remote-db';
    expect(new pg.Client({ connectionString: hostOverride }).connectionParameters.host).toBe(
      'remote-db',
    );

    for (const query of [
      'host=remote-db',
      'HOST=remote-db',
      'hostaddr=10.0.0.8',
      'host%61ddr=10.0.0.8',
      'port=5432',
      'db=vhhealth',
      'database=vhhealth',
      'dbname=vhhealth',
      'service=production',
      'servicefile=%2Fetc%2Fpostgresql%2Fpg_service.conf',
    ]) {
      expect(() => assertSyntheticSeedTarget({
        ...qaSeedOptions,
        connectionString: `postgresql://qa_writer@localhost:55432/vhhealth_test?${query}`,
      })).toThrow('must not use connection-target query parameters');
    }

    expect(() => assertSyntheticSeedTarget({
      ...qaSeedOptions,
      connectionString: 'postgresql://qa_writer@db.internal:5432/vhhealth_qa',
      env: {
        NODE_ENV: 'qa',
        VH_ALLOW_NON_TEST_DATA_SEED: 'true',
      },
    })).toThrow('requires local vhhealth_test or vhhealth_qa');
  });

  test('the production migration Job carries both independent skip controls', () => {
    expect(migrationJobSource).toContain(
      'node scripts/payroll-revision-754-preflight.mjs --report-only',
    );
    expect(migrationJobSource).not.toContain('npm run payroll:revision-754:preflight');
    expect(migrationJobSource).toContain('node scripts/ci-setup-db.mjs --skip-seeds');
    expect(runnerSource).toContain('lockPayrollRevision754Tables');
    expect(runnerSource).toContain('concurrentlyApplied.rowCount === 1');
    expect(runnerSource).toContain('forceTransactional: payrollReconciliationGate');
    expect(payrollRevisionPreflightSource).toContain("flag: 'wx', mode: 0o600");
    expect(payrollRevisionPreflightSource).toContain(
      'node scripts/payroll-revision-754-preflight.mjs --report-only',
    );
    expect(payrollRevisionPreflightSource).toContain(
      '--export /tmp/payroll-754-manifest.json from the backend working directory',
    );
    expect(payrollRevisionPreflightSource).not.toContain(
      'payroll:revision-754:preflight -- --report-only',
    );
    expect(payrollRevisionPreflightSource).toContain('schema_version: 2');
    expect(payrollRevisionPreflightSource).toContain(
      'to_jsonb(source_row)::text AS source_json',
    );
    expect(payrollRevisionPreflightSource).toContain(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
    );
    const sourceLock = payrollRevisionPreflightSource.indexOf(
      'LOCK TABLE ${PAYROLL_TABLES.map',
    );
    const authorityLock = payrollRevisionPreflightSource.indexOf(
      'LOCK TABLE ${PAYROLL_AUTHORITY_TABLES',
    );
    expect(sourceLock).toBeGreaterThan(-1);
    expect(authorityLock).toBeGreaterThan(sourceLock);
    expect(migrationJobSource).toMatch(
      /- name: CI_DB_SKIP_SEEDS\s+value: ["']1["']/,
    );
  });

  test('setup checks production seed policy before connecting to the database', () => {
    const guard = runnerSource.indexOf('assertCiSetupSeedPolicy({');
    const connect = runnerSource.indexOf('await client.connect()');

    expect(guard).toBeGreaterThan(-1);
    expect(connect).toBeGreaterThan(guard);
  });

  test('seed-free setup also skips RLS test-role provisioning', () => {
    expect(runnerSource).toContain(
      "logger.info('→ RLS test-role provisioning skipped (seed-free setup).\\n')",
    );
    const roleBoundary = runnerSource.indexOf('// Provision the non-owner RLS test roles');
    const skipBranch = runnerSource.indexOf('if (skipSeeds) {', roleBoundary);
    const provisionCall = runnerSource.indexOf('await provisionRlsTestRoles(', roleBoundary);

    expect(skipBranch).toBeGreaterThan(roleBoundary);
    expect(provisionCall).toBeGreaterThan(skipBranch);
  });

  test.each(directSeedSources)('$name enforces the shared direct-seed guard', ({ source }) => {
    expect(source).toContain('assertSyntheticSeedTarget({');
  });

  test.each(rootLocalToolSources)('$name refuses production use', ({ source }) => {
    expect(source).toContain("process.env.NODE_ENV === 'production'");
  });

  test('the local hands-on seed rejects target overrides before loading pg', () => {
    const guardCall = localHandsOnSeedSource.indexOf('assertSyntheticSeedTarget({');
    const pgLoad = localHandsOnSeedSource.indexOf("const pg = requireFromBackend('pg');");

    expect(localHandsOnSeedSource).toContain(
      "import { assertSyntheticSeedTarget } from '../apps/backend/scripts/lib/testDataSeedGuard.mjs';",
    );
    expect(localHandsOnSeedSource).toContain('allowNonTestOverride: false');
    expect(guardCall).toBeGreaterThan(-1);
    expect(pgLoad).toBeGreaterThan(guardCall);
    expect(() => assertSyntheticSeedTarget({
      connectionString: 'postgresql://localhost:55432/vhhealth_test?host=db.internal',
      env: { NODE_ENV: 'test' },
      scriptName: 'seed-local-hands-on-hospital-data.mjs',
      allowNonTestOverride: false,
    })).toThrow('must not use connection-target query parameters');
  });

  test('the QA tenant seed applies the shared structural guard before constructing a client', () => {
    const guardCall = qaTenantSeedSource.indexOf('assertSyntheticSeedTarget({');
    const clientConstruction = qaTenantSeedSource.indexOf('new pg.Client({');

    expect(qaTenantSeedSource).toContain(
      "import { assertSyntheticSeedTarget } from '../apps/backend/scripts/lib/testDataSeedGuard.mjs';",
    );
    expect(qaTenantSeedSource).toContain("allowedDatabaseNames: ['vhhealth_test', 'vhhealth_qa']");
    expect(qaTenantSeedSource).toContain('allowNonTestOverride: false');
    expect(guardCall).toBeGreaterThan(-1);
    expect(clientConstruction).toBeGreaterThan(guardCall);
  });

  test('the test-staff seed never writes its password to logs', () => {
    const staffSeed = directSeedSources.find(
      ({ name }) => name === 'seed-test-staff-accounts.mjs',
    ).source;

    expect(staffSeed).not.toContain('All accounts use password: ${PASSWORD}');
  });
});
