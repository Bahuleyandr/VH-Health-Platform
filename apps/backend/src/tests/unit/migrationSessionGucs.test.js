import { jest } from '@jest/globals';

import {
  MIGRATION_SESSION_GUCS,
  findDriftedGucs,
  pinMigrationSessionGucs,
  readMigrationSessionGucs,
} from '../../../scripts/lib/migrationSessionGucs.mjs';

function client(settings = {}) {
  return {
    query: jest.fn(async (sql, params) => {
      if (String(sql).startsWith('SELECT current_setting')) {
        return { rows: [{ value: settings[params[0]] }] };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
}

describe('migration session GUCs', () => {
  // ci-setup-db.mjs applies the whole chain through ONE long-lived connection,
  // so a plain SET outlives the migration that issued it. 000_baseline.sql is
  // pg_dump output whose preamble issues nine of them.
  test('pins exactly the two parameters the runner owns, and their directions', () => {
    // The values pull opposite ways on purpose — see the module header. Body
    // checking ON catches an uncompilable plpgsql body at CREATE time; row
    // security OFF keeps a policy-affected migration query LOUD (42501) instead
    // of silently returning zero rows.
    expect(MIGRATION_SESSION_GUCS).toEqual({
      check_function_bodies: 'on',
      row_security: 'off',
    });
  });

  test('the table is frozen, so a caller cannot widen it at runtime', () => {
    expect(Object.isFrozen(MIGRATION_SESSION_GUCS)).toBe(true);
  });

  test('pinning issues one SET per parameter', async () => {
    const db = client();
    await pinMigrationSessionGucs(db);
    expect(db.query.mock.calls.map(([sql]) => sql)).toEqual([
      'SET check_function_bodies = on',
      'SET row_security = off',
    ]);
  });

  test('a clean session reports no drift', () => {
    expect(findDriftedGucs({ check_function_bodies: 'on', row_security: 'off' })).toEqual([]);
  });

  test('a migration that leaked either parameter is reported, with both values', () => {
    // The exact trapdoor: a regenerated baseline stops pinning row_security, so
    // the session falls back to the default `on`.
    expect(findDriftedGucs({ check_function_bodies: 'on', row_security: 'on' }))
      .toEqual(['row_security=on (expected off)']);

    expect(findDriftedGucs({ check_function_bodies: 'off', row_security: 'off' }))
      .toEqual(['check_function_bodies=off (expected on)']);

    expect(findDriftedGucs({ check_function_bodies: 'off', row_security: 'on' })).toEqual([
      'check_function_bodies=off (expected on)',
      'row_security=on (expected off)',
    ]);
  });

  test('an unreadable parameter counts as drift rather than passing quietly', () => {
    expect(findDriftedGucs({})).toEqual([
      'check_function_bodies=undefined (expected on)',
      'row_security=undefined (expected off)',
    ]);
  });

  test('reading asks the server, not the runner s own idea of the value', async () => {
    const db = client({ check_function_bodies: 'off', row_security: 'on' });
    expect(await readMigrationSessionGucs(db)).toEqual({
      check_function_bodies: 'off',
      row_security: 'on',
    });
    expect(db.query.mock.calls.map(([, params]) => params[0]))
      .toEqual(['check_function_bodies', 'row_security']);
  });
});
