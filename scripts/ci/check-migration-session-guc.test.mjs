import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluate,
  findSessionGucLeaks,
  readMigrations,
  GRANDFATHERED,
  GUARDED_GUCS,
} from './check-migration-session-guc.mjs';

const BARE = '000_x.sql';
const LOCAL = '001_y.sql';

test('a bare session-level SET is a violation', () => {
  const files = [{ name: BARE, sql: 'BEGIN;\nSET check_function_bodies = false;\nCOMMIT;\n' }];
  const { violations } = evaluate(files, new Map());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, BARE);
  assert.equal(violations[0].line, 2);
});

test('SET LOCAL is allowed — it dies with the transaction', () => {
  const files = [{ name: LOCAL, sql: 'BEGIN;\nSET LOCAL check_function_bodies = false;\nCOMMIT;\n' }];
  const { violations, offenders } = evaluate(files, new Map());
  assert.equal(violations.length, 0);
  assert.equal(offenders.length, 0);
});

test('case and spacing do not let a bare SET through', () => {
  const variants = [
    'set check_function_bodies=false;',
    '   SET   check_function_bodies  =  off;',
    'SET check_function_bodies TO false;',
  ];
  for (const sql of variants) {
    const { violations } = evaluate([{ name: BARE, sql }], new Map());
    assert.equal(violations.length, 1, `should have flagged: ${sql}`);
  }
});

test('SET LOCAL variants are still allowed under odd spacing and case', () => {
  const variants = [
    'set local check_function_bodies = false;',
    '\tSET   LOCAL   check_function_bodies TO off;',
  ];
  for (const sql of variants) {
    const { violations } = evaluate([{ name: LOCAL, sql }], new Map());
    assert.equal(violations.length, 0, `should have allowed: ${sql}`);
  }
});

test('a grandfathered file is exempt but still reported as an offender', () => {
  const files = [{ name: BARE, sql: 'SET check_function_bodies = false;\n' }];
  const { violations, offenders } = evaluate(files, new Map([[BARE, 'documented reason']]));
  assert.equal(violations.length, 0);
  assert.equal(offenders.length, 1, 'exempt is not the same as invisible');
});

test('a grandfather entry whose file no longer offends is reported as stale', () => {
  const files = [{ name: BARE, sql: 'SELECT 1;\n' }];
  const { staleExemptions } = evaluate(files, new Map([[BARE, 'documented reason']]));
  assert.deepEqual(staleExemptions, [BARE]);
});

test('a grandfather entry for a file that does not exist is not called stale', () => {
  // Deleting a migration is not this gate's business; only a file that is present
  // and no longer offends should retire its exemption.
  const { staleExemptions } = evaluate([], new Map([[BARE, 'documented reason']]));
  assert.deepEqual(staleExemptions, []);
});

test('the real migrations tree passes, and both known offenders are grandfathered', () => {
  const files = readMigrations();
  assert.ok(files.length > 700, `expected the full tree, got ${files.length}`);

  const { violations, offenders, staleExemptions } = evaluate(files);
  assert.deepEqual(violations, [], 'no ungrandfathered session-level GUC leak may exist');
  assert.deepEqual(staleExemptions, [], 'no stale grandfather entries');

  // Pin the exact historical set so a third one cannot be added quietly.
  const names = [...new Set(offenders.map((o) => o.name))].sort();
  assert.deepEqual(names, [
    '000_baseline.sql',
    '758_pharmacy_advance_funding_authority.sql',
  ]);
  for (const name of names) {
    assert.ok(GRANDFATHERED.get(name)?.length > 20, `${name} needs a real justification`);
  }
});

test('the detector catches the exact regression it was written for', () => {
  // 744's shape had no SET of its own — it inherited the baseline's leak. The
  // regression this gate prevents is a NEW file re-introducing that leak.
  const reintroduced = {
    name: '760_hypothetical.sql',
    sql: 'BEGIN;\n-- functions before tables\nSET check_function_bodies = false;\nCREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NULL; END $f$;\nCOMMIT;\n',
  };
  const { violations } = evaluate([reintroduced]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].name, '760_hypothetical.sql');
});

test('findSessionGucLeaks reports every occurrence, not just the first', () => {
  const sql = 'SET check_function_bodies = false;\nSELECT 1;\nSET check_function_bodies = on;\n';
  const found = findSessionGucLeaks([{ name: BARE, sql }]);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.line), [1, 3]);
});

test('row_security is guarded alongside check_function_bodies', () => {
  assert.deepEqual(GUARDED_GUCS, ['check_function_bodies', 'row_security', 'client_min_messages']);

  const files = [{ name: BARE, sql: 'BEGIN;\nSET row_security = on;\nCOMMIT;\n' }];
  const { violations } = evaluate(files, new Map());
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2);
});

test('SET LOCAL row_security is allowed', () => {
  const files = [{ name: LOCAL, sql: 'BEGIN;\nSET LOCAL row_security = off;\nCOMMIT;\n' }];
  assert.equal(evaluate(files, new Map()).violations.length, 0);
});

test('a SET inside a CREATE FUNCTION signature is an attribute, not a leak', () => {
  // Migration 736's real shape. These apply only while the function runs and are
  // the correct way to write a SECURITY DEFINER sweep; flagging them would make
  // the gate un-satisfiable without amending an applied migration.
  const sql = [
    'CREATE FUNCTION public.sweep_expired()',
    'RETURNS INTEGER',
    'LANGUAGE sql',
    'VOLATILE',
    'SECURITY DEFINER',
    'SET search_path = pg_catalog, pg_temp',
    'SET row_security = off',
    'AS $sweep$',
    '  SELECT 1;',
    '$sweep$;',
  ].join('\n');

  const { violations, offenders } = evaluate([{ name: '736_x.sql', sql }], new Map());
  assert.deepEqual(violations, [], 'a function attribute is not a session leak');
  assert.deepEqual(offenders, [], 'and it is not even reported as an offender');
});

test('a session SET after a function body has closed is still caught', () => {
  // The signature tracker must not latch on: once AS $tag$ opens the body, a
  // later top-level SET is a real leak again.
  const sql = [
    'CREATE FUNCTION public.f() RETURNS int LANGUAGE sql',
    'SET row_security = off',
    'AS $f$ SELECT 1; $f$;',
    'SET row_security = on;',
  ].join('\n');

  const { violations } = evaluate([{ name: '737_x.sql', sql }], new Map());
  assert.equal(violations.length, 1, 'the post-body SET must still be flagged');
  assert.equal(violations[0].line, 4);
});

test('migration 736 in the real tree is not flagged', () => {
  // The concrete false positive this discriminator exists to avoid.
  const files = readMigrations();
  const seven36 = files.find((f) => f.name.startsWith('736_'));
  assert.ok(seven36, 'expected migration 736 to exist');
  assert.ok(/^[ \t]*SET[ \t]+row_security/im.test(seven36.sql), 'expected 736 to contain the shape');
  assert.deepEqual(
    findSessionGucLeaks([seven36]),
    [],
    '736 sets row_security only as a per-function attribute',
  );
});

test('the baseline leaks EVERY guarded GUC, and all are covered', () => {
  const files = readMigrations();
  const baseline = files.filter((f) => f.name === '000_baseline.sql');
  const found = findSessionGucLeaks(baseline);
  const gucs = found.map((f) => f.text.toLowerCase().match(/set\s+(\w+)/)[1]).sort();
  assert.deepEqual(gucs, ['check_function_bodies', 'client_min_messages', 'row_security']);
});
