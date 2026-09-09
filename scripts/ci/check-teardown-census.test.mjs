// Detector-capability probes for the teardown census gate.
//
// Every probe asserts the BASELINE first and then mutates it, so no probe can
// pass by tautology - a mutation test that also passes on the unmutated input
// has proved nothing.
//
// This file is deliberately dependency-free and never imports the census
// parser, because it runs in the `security` stage, which has no node_modules.
// The consequence is that it cannot execute a real corpus walk; the two probes
// at the bottom close that by asserting, at source level, that the --classes
// mode is wired to the real census module and that both CI stages invoke this
// gate. The walk itself is exercised by the gate running green on the real tree
// in the backend stage.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  ARTIFACT_PATH,
  CENSUS_MODULE,
  PREDICATES,
  REPO_ROOT,
  checkArtifactIntegrity,
  compareAgainstBase,
  compareCensus,
  defectSet,
  deriveCounts,
  impliedClassification,
  readCommitted,
} from './check-teardown-census.mjs';

// --------------------------------------------------------------------------
// A minimal census row, shaped exactly like the real artifact's entries.
// --------------------------------------------------------------------------

function row(file, { a = false, b = false, unresolved = 0, partial = 0, deletes = null } = {}) {
  const record = {
    file,
    classification: 'none',
    a: { users: a, tenants: false },
    b: { users: b, tenants: false },
    usesTenantTeardownHelper: false,
    hasReplicaWindow: a,
    localWrappers: [],
    unresolvedDynamicDeletes: unresolved,
    partiallyResolvedDynamicDeletes: partial,
    otherRelationDeletes: 0,
    deletes: deletes ?? [{
      line: 1,
      kind: 'literal',
      relations: ['users'],
      resolvedRelationCount: 1,
      binding: null,
      replica: a ? 'inside' : 'outside',
      inTransaction: b,
      transactionVia: b ? '$transaction' : null,
    }],
  };
  record.classification = impliedClassification(record);
  return record;
}

function census(files, overrides = {}) {
  return {
    schema: 'teardown-tx-census/v1',
    revision: 'deadbeef',
    counts: { filesWalked: 100, parseFailures: 0, filesUsingTenantTeardownHelper: 0, ...deriveCounts(files), ...overrides },
    parseFailures: [],
    files,
    ...(overrides.parseFailures ? { parseFailures: overrides.parseFailures } : {}),
  };
}

const CLEAN = () => [row('a.test.js'), row('b.test.js'), row('c.test.js')];
const allFilesExist = () => true;

// --------------------------------------------------------------------------
// P0 - the baselines. Asserted before anything is mutated.
// --------------------------------------------------------------------------

test('P0a baseline: an unchanged census compares clean, so every probe below is a real move', () => {
  const committed = census(CLEAN());
  const regenerated = census(CLEAN());
  const result = compareCensus(committed, regenerated);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.drift, []);
  // Clean for the right reason: the rows were actually read, not skipped.
  assert.equal(regenerated.files.length, 3);
  assert.deepEqual(defectSet(regenerated.files[0]), []);
});

test('P0b baseline: the committed artifact on main passes the integrity gate as it stands', () => {
  const committed = readCommitted();
  const result = checkArtifactIntegrity(committed);
  assert.deepEqual(result.failures, [], `integrity failures on the real artifact:\n${JSON.stringify(result.failures, null, 2)}`);
  // Non-empty population, so the pass is not vacuous.
  assert.ok(committed.files.length > 100, `expected a populated artifact, got ${committed.files.length} rows`);
});

// --------------------------------------------------------------------------
// P1-P4 - the four dev-0e named.
// --------------------------------------------------------------------------

test('P1 a synthetic (b) row planted in the regeneration FAILS the gate', () => {
  assert.deepEqual(compareCensus(census(CLEAN()), census(CLEAN())).failures, []);
  const regenerated = census([...CLEAN(), row('planted.deep.test.js', { b: true })]);
  const result = compareCensus(census(CLEAN()), regenerated);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'F1');
  assert.equal(result.failures[0].file, 'planted.deep.test.js');
  assert.deepEqual(result.failures[0].now, ['b']);
});

test('P2 a synthetic (a) row planted in the regeneration FAILS the gate', () => {
  assert.deepEqual(compareCensus(census(CLEAN()), census(CLEAN())).failures, []);
  const regenerated = census([...CLEAN(), row('planted.deep.test.js', { a: true })]);
  const result = compareCensus(census(CLEAN()), regenerated);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'F1');
  assert.deepEqual(result.failures[0].now, ['a']);
});

test('P3 an existing `none` row moving to (b) FAILS the gate', () => {
  const committed = census(CLEAN());
  assert.equal(committed.files[1].classification, 'none');
  assert.deepEqual(compareCensus(committed, census(CLEAN())).failures, []);

  const moved = CLEAN();
  moved[1] = row('b.test.js', { b: true });
  const result = compareCensus(committed, census(moved));
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'F2');
  assert.equal(result.failures[0].file, 'b.test.js');
  assert.deepEqual(result.failures[0].was, []);
  assert.deepEqual(result.failures[0].gained, ['b']);
});

test('P4 a walked-but-`none` file added PASSES, and is reported as drift', () => {
  const committed = census(CLEAN());
  const regenerated = census([...CLEAN(), row('t1e-new-suite.deep.test.js')]);
  const result = compareCensus(committed, regenerated);
  assert.deepEqual(result.failures, [], 'a correctly-torn-down new suite must never fail the gate');
  const added = result.drift.filter((item) => item.code === 'R-row-added');
  assert.equal(added.length, 1);
  assert.equal(added[0].file, 't1e-new-suite.deep.test.js');
  assert.equal(added[0].classification, 'none');
  // The count movement it causes is reported too, never failed.
  assert.ok(result.drift.some((item) => item.code === 'R-count' && item.key === 'filesWithTargetDelete'));
});

test('P4b a suite converted onto the helper leaves the population: reported, not failed', () => {
  const committed = census([...CLEAN(), row('converted.deep.test.js', { b: true })]);
  const result = compareCensus(committed, census(CLEAN()));
  assert.deepEqual(result.failures, []);
  const removed = result.drift.filter((item) => item.code === 'R-row-removed');
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].was, ['b']);
});

// --------------------------------------------------------------------------
// P5-P6 - the two whole-census failure predicates.
// --------------------------------------------------------------------------

test('P5 classUnknown > 0 in the regeneration FAILS the gate', () => {
  assert.deepEqual(compareCensus(census(CLEAN()), census(CLEAN())).failures, []);
  const unreadable = [...CLEAN(), row('opaque.deep.test.js', { unresolved: 1 })];
  assert.equal(unreadable[3].classification, 'unknown');
  const result = compareCensus(census(CLEAN()), census(unreadable));
  assert.ok(result.failures.some((item) => item.code === 'F3'));
  assert.deepEqual(result.failures.find((item) => item.code === 'F3').files, ['opaque.deep.test.js']);
});

test('P6 parseFailures > 0 in the regeneration FAILS the gate', () => {
  assert.deepEqual(compareCensus(census(CLEAN()), census(CLEAN())).failures, []);
  const broken = census(CLEAN(), { parseFailures: 1 });
  broken.parseFailures = [{ file: 'apps/backend/src/tests/broken.test.js', error: 'Unexpected token' }];
  const result = compareCensus(census(CLEAN()), broken);
  assert.ok(result.failures.some((item) => item.code === 'F4'));
});

// --------------------------------------------------------------------------
// I1-I5 - the dependency-free integrity gate.
// --------------------------------------------------------------------------

test('I1 counts that disagree with files[] FAIL, and agreeing counts pass', () => {
  const clean = census(CLEAN());
  assert.deepEqual(checkArtifactIntegrity(clean, { exists: allFilesExist }).failures, []);
  const tampered = census(CLEAN());
  tampered.counts.classB = 7;
  const result = checkArtifactIntegrity(tampered, { exists: allFilesExist });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'I1');
  assert.equal(result.failures[0].key, 'classB');
});

test('I1 hiding a defect row by deleting it without fixing the counts FAILS', () => {
  const withDefect = census([...CLEAN(), row('bad.deep.test.js', { b: true })]);
  assert.deepEqual(checkArtifactIntegrity(withDefect, { exists: allFilesExist }).failures, []);
  const hidden = { ...withDefect, files: withDefect.files.slice(0, 3) };
  const result = checkArtifactIntegrity(hidden, { exists: allFilesExist });
  assert.ok(result.failures.some((item) => item.code === 'I1' && item.key === 'classB'));
});

test('I2/I3 a committed artifact carrying unknowns or parse failures FAILS', () => {
  const unknown = census([...CLEAN(), row('opaque.test.js', { unresolved: 1 })]);
  assert.ok(checkArtifactIntegrity(unknown, { exists: allFilesExist }).failures.some((item) => item.code === 'I2'));

  const broken = census(CLEAN());
  broken.parseFailures = [{ file: 'x.js', error: 'boom' }];
  const result = checkArtifactIntegrity(broken, { exists: allFilesExist });
  assert.ok(result.failures.some((item) => item.code === 'I3'));
});

test('I4 a row naming a file that no longer exists FAILS', () => {
  const clean = census(CLEAN());
  assert.deepEqual(checkArtifactIntegrity(clean, { exists: allFilesExist }).failures, []);
  const result = checkArtifactIntegrity(clean, { exists: (file) => file !== 'b.test.js' });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'I4');
  assert.equal(result.failures[0].file, 'b.test.js');
});

test('I5 relabelling a (b) row as `none` without changing its fields FAILS', () => {
  const artifact = census([...CLEAN(), row('bad.deep.test.js', { b: true })]);
  assert.deepEqual(checkArtifactIntegrity(artifact, { exists: allFilesExist }).failures, []);
  artifact.files[3].classification = 'none';
  artifact.counts = { ...artifact.counts, ...deriveCounts(artifact.files) };
  const result = checkArtifactIntegrity(artifact, { exists: allFilesExist });
  assert.ok(result.failures.some((item) => item.code === 'I5' && item.file === 'bad.deep.test.js'));
  assert.equal(result.failures.find((item) => item.code === 'I5').implied, 'b');
});

// --------------------------------------------------------------------------
// P9 - F5, the base comparison. Catches "introduce a defect AND regenerate".
// --------------------------------------------------------------------------

test('P9 a committed artifact with a (b) row the base lacks FAILS against the base', () => {
  const base = census(CLEAN());
  assert.deepEqual(compareAgainstBase(census(CLEAN()), base).failures, []);
  const committed = census([...CLEAN(), row('sneaked.deep.test.js', { b: true })]);
  const result = compareAgainstBase(committed, base);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'F5');
  assert.equal(result.failures[0].file, 'sneaked.deep.test.js');
});

test('P9b the reverse - a base row absent from the committed artifact - PASSES with a report', () => {
  const base = census([...CLEAN(), row('converted.deep.test.js', { b: true })]);
  const result = compareAgainstBase(census(CLEAN()), base);
  assert.deepEqual(result.failures, []);
  assert.ok(result.drift.some((item) => item.code === 'R-row-removed' && item.file === 'converted.deep.test.js'));
});

test('P9c an existing row whose defect set GROWS relative to the base FAILS', () => {
  const base = census([...CLEAN(), row('creep.deep.test.js', { b: true })]);
  assert.deepEqual(compareAgainstBase(base, base).failures, []);
  const committed = census([...CLEAN(), row('creep.deep.test.js', { a: true, b: true })]);
  const result = compareAgainstBase(committed, base);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'F5');
  assert.deepEqual(result.failures[0].gained, ['a']);
});

test('P9d a base with no artifact at all is reported and PASSES (first landing)', () => {
  const result = compareAgainstBase(census([...CLEAN(), row('x.deep.test.js', { b: true })]), null);
  assert.deepEqual(result.failures, []);
  assert.ok(result.drift.some((item) => item.code === 'R-no-base-artifact'));
});

// --------------------------------------------------------------------------
// Wiring proofs. Source-level, because this file cannot run the parser.
// --------------------------------------------------------------------------

test('P7 the gate is wired into the unconditional security stage', () => {
  const security = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'security.mjs'), 'utf8');
  assert.match(security, /\['--test', 'scripts\/ci\/check-teardown-census\.test\.mjs'\]/);
  assert.match(security, /\['scripts\/ci\/check-teardown-census\.mjs', '--integrity'\]/);
});

test('P8 the class-regression gate is wired into BOTH backend tiers', () => {
  for (const workflow of ['_reusable-backend-lint-test.yml', '_reusable-backend-quick.yml']) {
    const source = readFileSync(join(REPO_ROOT, '.github', 'workflows', workflow), 'utf8');
    assert.match(
      source,
      /node \.\.\/\.\.\/scripts\/ci\/check-teardown-census\.mjs --classes/,
      `${workflow} does not invoke the class-regression gate`,
    );
  }
});

test('P8b the --classes mode regenerates from the real census module', () => {
  const gate = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'check-teardown-census.mjs'), 'utf8');
  // Dynamic, never a static import: a top-level parser import would redden the
  // dependency-free security stage on every PR.
  assert.match(gate, /await import\(CENSUS_MODULE\)/);
  assert.equal(CENSUS_MODULE, '../../apps/backend/scripts/teardown-tx-census.mjs');
  assert.doesNotMatch(gate, /^import .* from 'acorn'/m);
  assert.doesNotMatch(gate, /^import \{[^}]*\} from '\.\.\/\.\.\/apps\/backend/m);
  assert.match(gate, /census\(\{ revision: committed\.revision \}\)/);
});

test('every failure code the gate can emit has a stated predicate', () => {
  for (const code of ['F1', 'F2', 'F3', 'F4', 'F5', 'I1', 'I2', 'I3', 'I4', 'I5', 'R']) {
    assert.ok(typeof PREDICATES[code] === 'string' && PREDICATES[code].length > 40, `missing predicate for ${code}`);
  }
  assert.equal(ARTIFACT_PATH, 'docs/security/teardown-tx-census.json');
});

test('a gate that cannot run fails closed, and says why', () => {
  const gate = readFileSync(join(REPO_ROOT, 'scripts', 'ci', 'check-teardown-census.mjs'), 'utf8');
  // The rejection handler is explicit rather than left to Node's
  // unhandled-rejection default: --classes invoked without the parser must be a
  // failure with a diagnosis, never a silent pass and never a bare stack.
  assert.match(gate, /process\.exitCode = 1;/);
  assert.match(gate, /FAILED TO RUN/);
  assert.match(gate, /This is a failure, never a skip\./);
});
