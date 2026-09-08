import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MIGRATION_FILE,
  PLAYBOOK_PATH,
  REPO_ROOT,
  evaluate,
  migrationNumbers,
  parseNumberCell,
  parseRegistry,
  readMigrationFileNames,
} from './check-migration-registry.mjs';

// The registry is the only allocation authority for migration numbers. This
// gate fails when a migration file on disk carries a number no §5 row covers,
// so the registry can no longer go stale silently (it sat at "579+ UNASSIGNED"
// while main reached 790). Fixtures first; the live repository last, with its
// population asserted non-empty before the verdict is trusted.

const SECTION = (rows) => [
  '## 4. Something before',
  '',
  '| Block | Owner | Status |',
  '|---|---|---|',
  '| 900–999 | a table OUTSIDE §5 must not count | — |',
  '',
  '## 5. Migration number registry (the only allocation authority)',
  '',
  '| Block | Owner | Status |',
  '|---|---|---|',
  ...rows,
  '',
  'Gaps are released reservations — do not reuse.',
  '',
  '## 6. Worker rules',
  '',
  '| 1000–1999 | also outside §5 | — |',
  '',
].join('\n');

const FILES = (...numbers) => numbers.map((n) => `${String(n).padStart(3, '0')}_fixture.sql`);

test('parseNumberCell reads every first-cell form the registry uses', () => {
  const one = (from, to, openEnded = false) => [{ from, to, openEnded }];
  assert.deepEqual(parseNumberCell('…–367'), one(0, 367));
  assert.deepEqual(parseNumberCell('...-367'), one(0, 367));
  assert.deepEqual(parseNumberCell('368'), one(368, 368));
  assert.deepEqual(parseNumberCell('369–370'), one(369, 370));
  assert.deepEqual(parseNumberCell('369-370'), one(369, 370));
  assert.deepEqual(parseNumberCell(' **769–779** '), one(769, 779));
  assert.deepEqual(parseNumberCell('574 (two full filenames)'), one(574, 574));
  assert.deepEqual(parseNumberCell('579+'), one(579, Infinity, true));
  assert.deepEqual(parseNumberCell('804+ UNASSIGNED'), one(804, Infinity, true));
  assert.deepEqual(parseNumberCell('693–695, 697, 699–708'), [
    { from: 693, to: 695, openEnded: false },
    { from: 697, to: 697, openEnded: false },
    { from: 699, to: 708, openEnded: false },
  ]);
  assert.deepEqual(parseNumberCell('580 (see note, below)'), one(580, 580));
  assert.deepEqual(parseNumberCell('—'), []);
  assert.deepEqual(parseNumberCell(' Block '), []);
  assert.deepEqual(parseNumberCell('**Wave E — NL-13/NL-14 (authored 2026-07-09)**'), []);
  // A sub-table title that MENTIONS a range must not cover it: it has to start with prose.
  assert.deepEqual(parseNumberCell('**Rebuilt 2026-09-08 from git history for 579–790 (…)**'), []);
});

test('a comma-separated first cell covers every listed number', () => {
  const markdown = SECTION(['| 693–695, 697, 699–708 | payment gateway wave | on main (#878) |']);
  const { uncovered } = evaluate({ markdown, fileNames: FILES(693, 695, 696, 697, 698, 699, 708, 709) });
  assert.deepEqual(uncovered.map((u) => u.number), [696, 698, 709]);
});

test('a first cell that reads as a descending range is a parse error, not a row', () => {
  // A header cell starting with a date would otherwise silently cover 9..2026.
  assert.throws(() => parseNumberCell('2026-09 live blocks'), /descending range/);
  assert.throws(
    () => parseRegistry(SECTION(['| 2026-09 live blocks | x | y |'])),
    /descending range .* \(line 11\)/,
  );
});

test('parseRegistry reads number rows inside §5 only', () => {
  const { rows, sectionFound } = parseRegistry(SECTION([
    '| …–367 | shipped | on main |',
    '| 368 | single | in flight |',
    '| 369–370 | range | on main (#453) |',
    '| — | zero-migration slice | on main |',
    '| **Wave E — header row** | | |',
    '| 579+ | UNASSIGNED | — |',
  ]));
  assert.equal(sectionFound, true);
  assert.deepEqual(rows.map((r) => [r.from, r.to, r.openEnded]), [
    [0, 367, false],
    [368, 368, false],
    [369, 370, false],
    [579, Infinity, true],
  ]);
  assert.deepEqual(rows.map((r) => r.line), [11, 12, 13, 16]);
});

test('parseRegistry reports a missing §5 heading instead of passing vacuously', () => {
  const { rows, sectionFound } = parseRegistry('# no registry here\n\n| 580 | x | y |\n');
  assert.equal(sectionFound, false);
  assert.equal(rows.length, 0);
});

test('migrationNumbers uses the collision checker\'s predicate', () => {
  const numbers = migrationNumbers([
    '000_baseline.sql',
    '126b_create_data_breaches.sql', // letter before the underscore: outside the scheme
    '574_a.sql',
    '574_b.sql',
    'README.md',
    '790_cath_lab_case_attempts.sql',
  ]);
  assert.deepEqual([...numbers.keys()], [0, 574, 790]);
  assert.deepEqual(numbers.get(574), ['574_a.sql', '574_b.sql']);
  assert.equal(MIGRATION_FILE.test('126b_create_data_breaches.sql'), false);
});

test('positive control: a number inside a shipped row or a live block is covered', () => {
  const markdown = SECTION([
    '| …–579 | shipped | on main |',
    '| 580–584 | care pathways | on main (#612) |',
    '| 769–779 | Plan 4 live block | 769, 770 on main; next 771 |',
    '| 804+ | UNASSIGNED | — |',
  ]);
  const { uncovered } = evaluate({ markdown, fileNames: FILES(0, 367, 579, 580, 584, 771, 779) });
  assert.deepEqual(uncovered, []);
});

test('negative control: a number no row covers fails, with its file names', () => {
  const markdown = SECTION([
    '| …–579 | shipped | on main |',
    '| 580–584 | care pathways | on main (#612) |',
  ]);
  const { uncovered } = evaluate({ markdown, fileNames: FILES(584, 585, 790) });
  assert.deepEqual(uncovered, [
    { number: 585, files: ['585_fixture.sql'] },
    { number: 790, files: ['790_fixture.sql'] },
  ]);
});

test('an open-ended "N+ UNASSIGNED" row covers nothing', () => {
  const markdown = SECTION([
    '| …–579 | shipped | on main |',
    '| 580+ | UNASSIGNED — 580 is next-free | — |',
  ]);
  const { uncovered } = evaluate({ markdown, fileNames: FILES(579, 580, 581) });
  assert.deepEqual(uncovered.map((u) => u.number), [580, 581]);
});

test('tables outside §5 do not cover anything', () => {
  // §4's 900–999 and §6's 1000–1999 rows exist in every fixture above.
  const markdown = SECTION(['| …–579 | shipped | on main |']);
  const { uncovered } = evaluate({ markdown, fileNames: FILES(950, 1500) });
  assert.deepEqual(uncovered.map((u) => u.number), [950, 1500]);
});

test('live repository: every migration on disk is covered by the current §5', () => {
  const markdown = readFileSync(PLAYBOOK_PATH, 'utf8');
  const fileNames = readMigrationFileNames();
  const { rows, numbers, uncovered, sectionFound } = evaluate({ markdown, fileNames });

  // Population before verdict: an empty registry or an empty directory would
  // make the assertion below meaningless.
  assert.equal(sectionFound, true);
  assert.ok(rows.length >= 100, `expected ≥100 registry rows, parsed ${rows.length}`);
  assert.ok(numbers.size >= 700, `expected ≥700 distinct migration numbers, found ${numbers.size}`);
  assert.ok(numbers.has(790), 'the 790 migration must be part of the measured population');

  assert.deepEqual(uncovered, [], `uncovered: ${uncovered.map((u) => u.number).join(', ')}`);
});

test('mutation: the stale registry (579+ UNASSIGNED) is detected against the live directory', () => {
  // The tail of §5 exactly as it stood on main at 5def41d10, before this gate.
  const stale = SECTION([
    '| …–367 | shipped through NL-1 P3 SCIM | on main |',
    '| 368–578 | (collapsed for the fixture) | on main |',
    '| 579+ | UNASSIGNED — **579 is next-free at this revision** | — |',
  ]);
  const { uncovered } = evaluate({ markdown: stale, fileNames: readMigrationFileNames() });
  const numbers = uncovered.map((u) => u.number);
  assert.ok(numbers.length >= 180, `expected the 580–790 backlog, got ${numbers.length}`);
  assert.equal(numbers[0], 579);
  assert.ok(numbers.includes(580));
  assert.ok(numbers.includes(790));
});

test('mutation: deleting the rows that name 790 from the live registry makes 790 uncovered', () => {
  // Proves the verdict for 790 comes from the rows that name it, not from a
  // floor or an accidental wide range elsewhere in the table.
  const live = readFileSync(PLAYBOOK_PATH, 'utf8');
  const withoutRows = live
    .split(/\r?\n/)
    .filter((line) => !/^\|\s*\**790/.test(line))
    .join('\n');
  assert.notEqual(withoutRows, live, 'the live registry must contain rows starting with 790');
  const { uncovered } = evaluate({ markdown: withoutRows, fileNames: readMigrationFileNames() });
  assert.deepEqual(uncovered.map((u) => u.number), [790]);
});

test('the gate is wired into the unconditional security stage', () => {
  const security = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'security.mjs'), 'utf8');
  assert.match(security, /\['--test', 'scripts\/ci\/check-migration-registry\.test\.mjs'\]/);
  assert.match(security, /\['scripts\/ci\/check-migration-registry\.mjs'\]/);
});
