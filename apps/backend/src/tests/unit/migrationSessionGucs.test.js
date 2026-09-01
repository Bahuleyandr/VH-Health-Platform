import { jest } from '@jest/globals';

import {
  MIGRATION_SESSION_GUCS,
  findDriftedGucs,
  isIdempotencyNotice,
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
  test('pins exactly the parameters the runner owns, and their directions', () => {
    // The values pull opposite ways on purpose — see the module header. Body
    // checking ON catches an uncompilable plpgsql body at CREATE time; row
    // security OFF keeps a policy-affected migration query LOUD (42501) instead
    // of silently returning zero rows.
    expect(MIGRATION_SESSION_GUCS).toEqual({
      check_function_bodies: 'on',
      row_security: 'off',
      client_min_messages: 'notice',
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
      'SET client_min_messages = notice',
    ]);
  });

  const CLEAN = { check_function_bodies: 'on', row_security: 'off', client_min_messages: 'notice' };

  test('a clean session reports no drift', () => {
    expect(findDriftedGucs(CLEAN)).toEqual([]);
  });

  test('a migration that leaked either parameter is reported, with both values', () => {
    // The exact trapdoor: a regenerated baseline stops pinning row_security, so
    // the session falls back to the default `on`.
    expect(findDriftedGucs({ ...CLEAN, row_security: 'on' }))
      .toEqual(['row_security=on (expected off)']);

    expect(findDriftedGucs({ ...CLEAN, check_function_bodies: 'off' }))
      .toEqual(['check_function_bodies=off (expected on)']);

    // The baseline's own preamble value, left in place.
    expect(findDriftedGucs({ ...CLEAN, client_min_messages: 'warning' }))
      .toEqual(['client_min_messages=warning (expected notice)']);

    expect(findDriftedGucs({ check_function_bodies: 'off', row_security: 'on', client_min_messages: 'warning' })).toEqual([
      'check_function_bodies=off (expected on)',
      'row_security=on (expected off)',
      'client_min_messages=warning (expected notice)',
    ]);
  });

  test('an unreadable parameter counts as drift rather than passing quietly', () => {
    expect(findDriftedGucs({})).toEqual([
      'check_function_bodies=undefined (expected on)',
      'row_security=undefined (expected off)',
      'client_min_messages=undefined (expected notice)',
    ]);
  });

  test('reading asks the server, not the runner s own idea of the value', async () => {
    const db = client({ check_function_bodies: 'off', row_security: 'on', client_min_messages: 'warning' });
    expect(await readMigrationSessionGucs(db)).toEqual({
      check_function_bodies: 'off',
      row_security: 'on',
      client_min_messages: 'warning',
    });
    expect(db.query.mock.calls.map(([, params]) => params[0]))
      .toEqual(['check_function_bodies', 'row_security', 'client_min_messages']);
  });
});

describe('idempotency notice filter', () => {
  // Pinning client_min_messages = notice un-mutes 48 deliberate RAISE NOTICE
  // sites, but also ~2,960 Postgres IF [NOT] EXISTS no-ops per full apply. The
  // filter drops only the latter, and fails OPEN: unrecognised means logged.
  test('suppresses Postgres IF [NOT] EXISTS no-ops', () => {
    for (const message of [
      'relation "clinical_alerts" already exists, skipping',
      'column "tenant_id" of relation "wards" already exists, skipping',
      'policy "tenant_isolation" for relation "wards" does not exist, skipping',
      'constraint "chk_x" of relation "t" does not exist, skipping',
      'trigger "trg_x" for relation "t" does not exist, skipping',
      'extension "vector" already exists, skipping',
      '  index "idx_x" does not exist, skipping  ',
    ]) {
      expect(isIdempotencyNotice(message)).toBe(true);
    }
  });

  test('keeps deliberate migration diagnostics', () => {
    for (const message of [
      // 237_force_rls_phi_tables.sql:46 — a security control not applied
      // because the table was absent, reported and then swallowed.
      'Skipping FORCE RLS on payment_transactions: table does not exist',
      'FORCE ROW LEVEL SECURITY applied to public.users',
      'Tenant-isolated wards (tenant_id + RLS + policy)',
      'Added tenant_id to auth table otp_sessions (backfill via users.phone)',
      // 299 — this is why a blanket /, skipping$/ rule was rejected.
      'schema drift archive: public.foo not present, skipping',
      'migration 304: skipping wards (no tenant_id column here)',
      // Not a no-op: an identifier silently truncated can collide.
      'identifier "a_very_long_name" will be truncated to "a_very_long"',
    ]) {
      expect(isIdempotencyNotice(message)).toBe(false);
    }
  });

  test('an empty or missing message is not mistaken for boilerplate', () => {
    expect(isIdempotencyNotice(undefined)).toBe(false);
    expect(isIdempotencyNotice(null)).toBe(false);
    expect(isIdempotencyNotice('')).toBe(false);
  });
});
