import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import {
  assertMigrationBatchSucceeded,
  assertMigrationTrackerReady,
} from '../../../scripts/lib/migrationBatchGuard.mjs';

const runnerSource = readFileSync(
  new URL('../../../scripts/ci-setup-db.mjs', import.meta.url),
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
      'await assertMigrationBatchSucceeded({ errors, client, logger })',
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
