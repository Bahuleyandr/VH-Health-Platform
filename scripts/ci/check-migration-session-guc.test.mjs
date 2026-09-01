import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluate,
  findSessionGucLeaks,
  readMigrations,
  GRANDFATHERED,
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
