// Regression suite for the migration-number collision gate.
//   node --test scripts/ci/check-migration-number-collisions.test.mjs
//
// The gate lives at apps/backend/scripts/check-migration-number-collisions.mjs
// and runs as its own step in both backend tiers
// (_reusable-backend-lint-test.yml, _reusable-backend-quick.yml, each
// `run: npm run check:migration-numbers`). This suite runs in the unconditional
// `security` stage beside the other migration guards, so tier routing cannot
// skip the proof.
//
// WHAT WAS WRONG
//
// The gate's comment said the historical collisions were grandfathered "BY
// EXACT FILENAME"; the code held `new Set(['203','211','217','233','574'])` and
// filtered with `!GRANDFATHERED.has(num)` — an exemption BY NUMBER. A second,
// count-based guard (`files.length > (num === '217' ? 3 : 2)`) partly covered
// for it, so a bare ADDITION on a grandfathered number did fail. What passed
// silently was a COUNT-PRESERVING SUBSTITUTION: rename a grandfathered file, or
// delete one and land a brand-new file beside the survivor, and a genuine new
// collision on 203/211/217/233/574 shipped green.
//
// LEGACY_verdict below reproduces the old predicate verbatim. It is calibrated
// against the old code's observed behaviour on the mutations it DID catch
// before it is used to demonstrate the two it did not — a demonstration that
// rests on an uncalibrated reimplementation proves nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GRANDFATHERED_FILES,
  MIGRATION_FILE,
  MIGRATIONS_DIR,
  evaluate,
  groupByNumber,
  readMigrationFileNames,
} from '../../apps/backend/scripts/check-migration-number-collisions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const SCRIPT = join(REPO_ROOT, 'apps/backend/scripts/check-migration-number-collisions.mjs');

// The five numbers and eleven filenames the gate grandfathers, as they stand in
// apps/backend/src/migrations. Written out rather than derived from
// GRANDFATHERED_FILES so the meta-test below compares two independent lists.
const COLLIDED_NUMBERS = ['203', '211', '217', '233', '574'];
const TRIPLE_NUMBER = '217';
const GRANDFATHERED_COUNT = 11;

// --- the old predicate, verbatim -------------------------------------------
// From apps/backend/scripts/check-migration-number-collisions.mjs at
// 6295debbf, both filters:
//   .filter(([num, files]) => files.length > 1 && !GRANDFATHERED.has(num))
//   .filter(([num, files]) => GRANDFATHERED.has(num) && files.length > (num === '217' ? 3 : 2))
const LEGACY_NUMBERS = new Set(['203', '211', '217', '233', '574']);

function LEGACY_verdict(fileNames) {
  const byNumber = groupByNumber(fileNames);
  const offenders = [...byNumber.entries()]
    .filter(([num, files]) => files.length > 1 && !LEGACY_NUMBERS.has(num));
  const grown = [...byNumber.entries()]
    .filter(([num, files]) => LEGACY_NUMBERS.has(num) && files.length > (num === '217' ? 3 : 2));
  return offenders.length > 0 || grown.length > 0 ? 'REJECT' : 'PASS';
}

// --- fixtures ---------------------------------------------------------------

const LIVE_FILES = readMigrationFileNames();

/**
 * A temp directory holding the live migration FILE NAMES as empty files. The
 * gate reads names only, so this is a faithful copy for its purposes and the
 * real directory is never touched. `mutate` receives the directory path.
 */
function fixtureDir(t, mutate = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vh-mignum-'));
  mkdirSync(dir, { recursive: true });
  for (const f of LIVE_FILES) writeFileSync(join(dir, f), '');
  mutate(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function namesIn(dir) {
  return readMigrationFileNames(dir);
}

function runGate(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, '--migrations', dir], { encoding: 'utf8' });
  assert.equal(r.error, undefined, `gate failed to spawn: ${r.error}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// --- ground truth: the lore must match the directory ------------------------

test('the live directory carries five collided numbers across eleven files, 217 a triple', () => {
  // Population first: a verdict over an empty read is not evidence.
  assert.ok(LIVE_FILES.length > 700, `only ${LIVE_FILES.length} migration files read`);

  const byNumber = groupByNumber(LIVE_FILES);
  const duplicated = [...byNumber.entries()].filter(([, files]) => files.length > 1);

  // Derived from "which numbers carry more than one file on disk", not from the
  // grandfathered set — so this cannot agree with the set by construction.
  assert.deepEqual(duplicated.map(([n]) => n).sort(), [...COLLIDED_NUMBERS].sort());
  assert.equal(duplicated.reduce((n, [, files]) => n + files.length, 0), GRANDFATHERED_COUNT);
  assert.equal(byNumber.get(TRIPLE_NUMBER).length, 3);
  for (const [num, files] of duplicated) {
    if (num === TRIPLE_NUMBER) continue;
    assert.equal(files.length, 2, `${num} is neither a pair nor the triple`);
  }

  // And the set the code exempts is exactly those eleven files.
  const onDisk = duplicated.flatMap(([, files]) => files).sort();
  assert.deepEqual([...GRANDFATHERED_FILES].sort(), onDisk);
  assert.equal(GRANDFATHERED_FILES.size, GRANDFATHERED_COUNT);
});

test('the gate exempts by filename, not by number', () => {
  // The defect in one assertion: every grandfathered entry is a full filename
  // matching the migration pattern, never a bare number.
  for (const entry of GRANDFATHERED_FILES) {
    assert.match(entry, MIGRATION_FILE, `${entry} is not a migration filename`);
  }
  assert.equal(MIGRATIONS_DIR.endsWith(join('apps', 'backend', 'src', 'migrations')), true);
});

// --- (a) positive control ---------------------------------------------------

test('positive control: the live migrations directory passes', () => {
  const r = runGate(MIGRATIONS_DIR);
  assert.equal(r.status, 0, `live directory rejected:\n${r.stderr}`);
  assert.match(r.stdout, /Migration numbering clean/);
  assert.match(r.stdout, new RegExp(`${LIVE_FILES.length} migration files`));
  assert.match(r.stdout, new RegExp(`${GRANDFATHERED_COUNT} grandfathered files`));

  // Same verdict through the pure function, and the default path is the live
  // directory (so the override did not quietly become the only working input).
  assert.deepEqual(evaluate(LIVE_FILES).offenders, []);
  const r2 = runGate(MIGRATIONS_DIR);
  assert.equal(r2.status, 0);
});

test('an untouched temp copy passes too (the fixture itself is not the failure)', (t) => {
  const dir = fixtureDir(t);
  assert.equal(namesIn(dir).length, LIVE_FILES.length);
  const r = runGate(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(LEGACY_verdict(namesIn(dir)), 'PASS');
});

// --- LEGACY_verdict calibration --------------------------------------------

test('LEGACY_verdict reproduces the old gate on the mutations it did catch', (t) => {
  // Observed against the real pre-fix script (6295debbf) on a materialised copy
  // of the directory: a bare addition on a grandfathered number was rejected by
  // its count guard, a plain new duplicate by its offenders filter, and a
  // deletion was tolerated. If this stub disagreed with any of those, the
  // demonstration below would be worthless.
  const added217 = fixtureDir(t, (d) => writeFileSync(join(d, '217_synthetic_probe.sql'), ''));
  assert.equal(LEGACY_verdict(namesIn(added217)), 'REJECT');

  const added203 = fixtureDir(t, (d) => writeFileSync(join(d, '203_synthetic_probe.sql'), ''));
  assert.equal(LEGACY_verdict(namesIn(added203)), 'REJECT');

  const dup999 = fixtureDir(t, (d) => {
    writeFileSync(join(d, '999_probe_a.sql'), '');
    writeFileSync(join(d, '999_probe_b.sql'), '');
  });
  assert.equal(LEGACY_verdict(namesIn(dup999)), 'REJECT');

  const dropped = fixtureDir(t, (d) => unlinkSync(join(d, '217_lab_results_investigation_link.sql')));
  assert.equal(LEGACY_verdict(namesIn(dropped)), 'PASS');
});

// --- (b) MUTATION 1: a new file on the grandfathered triple -----------------

test('MUTATION 1a: a fourth 217_*.sql is rejected, naming 217 and all four files', (t) => {
  const dir = fixtureDir(t, (d) => writeFileSync(join(d, '217_synthetic_probe.sql'), ''));
  const r = runGate(dir);

  assert.equal(r.status, 1, `expected rejection, got exit ${r.status}\n${r.stdout}`);
  assert.match(r.stderr, /Duplicate migration numbers detected/);
  assert.match(r.stderr, /^ {2}217: /m);
  for (const f of [
    '217_appointments_visit_no.sql',
    '217_emergency_visits_triage_ats_codes.sql',
    '217_lab_results_investigation_link.sql',
    '217_synthetic_probe.sql',
  ]) {
    assert.match(r.stderr, new RegExp(f.replace(/\./g, '\\.')));
  }
  assert.match(r.stderr, /not grandfathered: 217_synthetic_probe\.sql/);

  // Honest scoreboard: the OLD code caught this one too, via its count guard.
  // This mutation proves the new predicate did not regress, not that the hole
  // was here.
  assert.equal(LEGACY_verdict(namesIn(dir)), 'REJECT');
});

test('MUTATION 1b: renaming a grandfathered 217 file is rejected — the OLD code PASSED it', (t) => {
  // The hole. Count-preserving substitution on a grandfathered number: 217 still
  // carries three files, so the old count guard saw nothing, and the old
  // offenders filter exempted the NUMBER outright.
  const dir = fixtureDir(t, (d) => renameSync(
    join(d, '217_lab_results_investigation_link.sql'),
    join(d, '217_synthetic_probe.sql'),
  ));
  const names = namesIn(dir);
  assert.equal(names.length, LIVE_FILES.length, 'the rename must not change the file count');
  assert.equal(groupByNumber(names).get('217').length, 3, '217 must still carry exactly three files');

  assert.equal(LEGACY_verdict(names), 'PASS'); // ← the silent green that shipped

  const r = runGate(dir);
  assert.equal(r.status, 1, `the fixed gate must reject this\n${r.stdout}`);
  assert.match(r.stderr, /^ {2}217: /m);
  assert.match(r.stderr, /not grandfathered: 217_synthetic_probe\.sql/);
});

test('MUTATION 1c: a new 203 file beside a surviving grandfathered one is rejected — the OLD code PASSED it', (t) => {
  // The same hole in its realistic shape: one grandfathered file is consolidated
  // away and a brand-new migration takes the freed slot. 203 still carries two
  // files, so the count guard is blind and the number exemption does the rest.
  const dir = fixtureDir(t, (d) => {
    unlinkSync(join(d, '203_investigations_collection_instructions.sql'));
    writeFileSync(join(d, '203_synthetic_probe.sql'), '');
  });
  const names = namesIn(dir);
  assert.equal(groupByNumber(names).get('203').length, 2);

  assert.equal(LEGACY_verdict(names), 'PASS'); // ← the silent green that shipped

  const r = runGate(dir);
  assert.equal(r.status, 1, `the fixed gate must reject this\n${r.stdout}`);
  assert.match(r.stderr, /^ {2}203: /m);
  assert.match(r.stderr, /203_insurance_master_seed_and_admission_link\.sql/);
  assert.match(r.stderr, /not grandfathered: 203_synthetic_probe\.sql/);
});

// --- (c) MUTATION 2: an ordinary new collision ------------------------------

test('MUTATION 2: two files on a non-grandfathered number are rejected', (t) => {
  const dir = fixtureDir(t, (d) => {
    writeFileSync(join(d, '999_probe_a.sql'), '');
    writeFileSync(join(d, '999_probe_b.sql'), '');
  });
  const r = runGate(dir);

  assert.equal(r.status, 1, `expected rejection, got exit ${r.status}\n${r.stdout}`);
  assert.match(r.stderr, /^ {2}999: 999_probe_a\.sql, 999_probe_b\.sql$/m);
  assert.match(r.stderr, /not grandfathered: 999_probe_a\.sql, 999_probe_b\.sql/);
  assert.equal(LEGACY_verdict(namesIn(dir)), 'REJECT'); // never broken; regression control
});

test('a single file on a fresh number is fine', (t) => {
  const dir = fixtureDir(t, (d) => writeFileSync(join(d, '999_probe_solo.sql'), ''));
  assert.equal(runGate(dir).status, 0);
});

test('a non-numeric migration filename is outside the scheme, not a collision', (t) => {
  // `126b_create_data_breaches.sql` already lives in the tree; two such files
  // must not read as a pair.
  const dir = fixtureDir(t, (d) => {
    writeFileSync(join(d, '126c_alpha_prefix_one.sql'), '');
    writeFileSync(join(d, '126c_alpha_prefix_two.sql'), '');
  });
  assert.equal(runGate(dir).status, 0);
});

// --- (d) grandfathering does not require all eleven to exist ----------------

test('removing a grandfathered file still passes (the exemption is not a headcount)', (t) => {
  const dir = fixtureDir(t, (d) => unlinkSync(join(d, '217_lab_results_investigation_link.sql')));
  const names = namesIn(dir);
  assert.equal(groupByNumber(names).get('217').length, 2);

  const r = runGate(dir);
  assert.equal(r.status, 0, `a consolidation must not fail the gate\n${r.stderr}`);
  assert.match(r.stdout, /10 grandfathered files/);
});

test('reducing a grandfathered number to one file still passes', (t) => {
  const dir = fixtureDir(t, (d) => unlinkSync(join(d, '211_vitals_urine_dipstick.sql')));
  assert.equal(runGate(dir).status, 0);
});

test('but a new file on a REDUCED grandfathered number is still rejected', (t) => {
  // 211 drops to one grandfathered file, then a new migration takes 211. The old
  // code passed this on both filters (number exempt; count 2, not > 2).
  const dir = fixtureDir(t, (d) => {
    unlinkSync(join(d, '211_vitals_urine_dipstick.sql'));
    writeFileSync(join(d, '211_synthetic_probe.sql'), '');
  });
  assert.equal(LEGACY_verdict(namesIn(dir)), 'PASS');
  const r = runGate(dir);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /not grandfathered: 211_synthetic_probe\.sql/);
});

// --- wiring: the gate runs, and a failure reddens the job -------------------

test('this suite is wired into the unconditional security stage', () => {
  const security = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'security.mjs'), 'utf8');
  assert.match(
    security,
    /\['--test', 'scripts\/ci\/check-migration-number-collisions\.test\.mjs'\]/,
  );
  // `run` in scripts/ci/lib.mjs throws on both spawnSync outcomes — `result.error`
  // and a non-zero `result.status` — so a red suite propagates out of
  // `node scripts/ci/run.mjs --only=security` instead of being logged and passed.
  const lib = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'lib.mjs'), 'utf8');
  assert.match(lib, /if \(result\.error\) \{\s*\r?\n\s*throw result\.error;/);
  assert.match(lib, /if \(result\.status !== 0\) \{\s*\r?\n\s*throw new Error\(/);
});

test('the gate itself runs as its own unconditional step in both backend tiers', () => {
  for (const file of ['_reusable-backend-quick.yml', '_reusable-backend-lint-test.yml']) {
    const workflow = readFileSync(join(REPO_ROOT, '.github', 'workflows', file), 'utf8');
    const step = /- name: Migration number collision guard[^\n]*\r?\n((?:\s+[^\n]*\r?\n)*?)\s*(?=- name:|\r?\n)/
      .exec(workflow);
    assert.ok(step, `${file}: collision guard step not found`);
    assert.match(step[1], /run: npm run check:migration-numbers/);
    // A step-level `if:` is invisible to the job aggregate — the job still
    // reports success. That is this repository's recurring silent-skip class,
    // so pin its absence rather than only the step's presence.
    assert.doesNotMatch(step[1], /^\s+if:/m, `${file}: the collision guard grew a step condition`);
  }
});

// --- fail-closed on an empty read -------------------------------------------

test('an empty directory fails rather than reporting a clean verdict', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'vh-mignum-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = runGate(dir);
  assert.equal(r.status, 1, `an empty read must not pass\n${r.stdout}`);
  assert.match(r.stderr, /no migration files matched/);
});
