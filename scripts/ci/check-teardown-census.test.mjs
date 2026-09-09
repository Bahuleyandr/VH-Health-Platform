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
  ALL_COUNTS,
  DERIVED_COUNTS,
  FLOOR_ONLY_COUNTS,
  defectSet,
  deriveCountsFromArtifact,
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

function shell(files) {
  return {
    schema: 'teardown-tx-census/v1',
    revision: 'deadbeef',
    counts: {},
    parseFailures: [],
    files,
  };
}

// Build an artifact whose counts are consistent by construction, using the
// census's own expressions, then apply any override. Floors are set high enough
// to clear I7 unless a probe is deliberately testing them.
function census(files, overrides = {}) {
  const artifact = shell(files);
  artifact.counts = {
    ...deriveCountsFromArtifact({ ...artifact, counts: { filesWalked: 2000, filesUsingTenantTeardownHelper: 5 } }),
    filesWalked: 2000,
    filesUsingTenantTeardownHelper: 5,
    ...overrides,
  };
  if (overrides.parseFailuresList) artifact.parseFailures = overrides.parseFailuresList;
  delete artifact.counts.parseFailuresList;
  return artifact;
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
  const broken = census(CLEAN(), {
    parseFailures: 1,
    parseFailuresList: [{ file: 'apps/backend/src/tests/broken.test.js', error: 'Unexpected token' }],
  });
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

  const broken = census(CLEAN(), { parseFailures: 1, parseFailuresList: [{ file: 'x.js', error: 'boom' }] });
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
  artifact.counts = { ...artifact.counts, ...deriveCountsFromArtifact(artifact) };
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
  // The parser-bearing module must never be imported statically - that is what
  // would redden the dependency-free security stage. The counts module MAY be,
  // and is, because it imports nothing at all.
  assert.doesNotMatch(gate, /^import[^;]*from '[^']*teardown-tx-census\.mjs'/m);
  assert.match(gate, /census\(\{ revision: committed\.revision \}\)/);

  const counts = readFileSync(
    join(REPO_ROOT, 'apps', 'backend', 'scripts', 'lib', 'teardown-census-counts.mjs'),
    'utf8',
  );
  assert.doesNotMatch(counts, /^import /m, 'the shared counts module must stay dependency-free');
  // And it is genuinely shared: the census calls it rather than inlining the
  // expressions, so the artifact and this gate cannot drift apart.
  const censusSource = readFileSync(
    join(REPO_ROOT, 'apps', 'backend', 'scripts', 'teardown-tx-census.mjs'),
    'utf8',
  );
  assert.match(censusSource, /import \{ computeCounts \} from '\.\/lib\/teardown-census-counts\.mjs'/);
  assert.match(censusSource, /const counts = computeCounts\(records, \{/);
  assert.doesNotMatch(censusSource, /filesReachedByDynamicArm:/, 'the census must not keep a second copy of the expressions');
});

test('every failure code the gate can emit has a stated predicate', () => {
  for (const code of ['F1', 'F2', 'F3', 'F4', 'F5', 'I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'R']) {
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

// --------------------------------------------------------------------------
// The corpus is DEGENERATE: 609 `literal` and 16 `dynamic` deletes, zero
// `dynamic-partial`, zero `unresolved`, and no delete with empty `relations`.
// Every rule below is therefore asserted only by planted fixtures - the real
// artifact cannot distinguish a correct rule from several wrong ones.
// --------------------------------------------------------------------------

function deleteOf(kind, relations) {
  return {
    line: 1, kind, relations, resolvedRelationCount: relations.length,
    binding: null, replica: 'outside', inTransaction: false, transactionVia: null,
  };
}

function rowWithDeletes(file, deletes) {
  const record = row(file);
  record.deletes = deletes;
  return record;
}

test('the corpus really is degenerate, which is why the probes below plant fixtures', () => {
  const kinds = new Set();
  let emptyRelations = 0;
  for (const record of readCommitted().files) {
    for (const item of record.deletes) {
      kinds.add(item.kind);
      if (item.relations.length === 0) emptyRelations += 1;
    }
  }
  assert.deepEqual([...kinds].sort(), ['dynamic', 'literal']);
  assert.equal(emptyRelations, 0);
});

test('a `dynamic-partial` delete counts as the dynamic arm, exactly like `dynamic`', () => {
  const partial = census([rowWithDeletes('partial.deep.test.js', [deleteOf('dynamic-partial', ['users'])])]);
  assert.equal(partial.counts.filesReachedByDynamicArm, 1);
  assert.equal(partial.counts.filesReachedOnlyByDynamicArm, 1);
  assert.equal(partial.counts.filesWithDynamicUsersAndNoLiteralUsers, 1);
  assert.equal(partial.counts.filesReachedByLiteralArm, 0);
  // A rule written as `kind === 'dynamic'` would score all four as 0 here and
  // still match every number in the committed artifact.
  assert.deepEqual(checkArtifactIntegrity(partial, { exists: allFilesExist }).failures, []);
});

test('a dynamic delete with NO resolved relations does NOT count as reached', () => {
  const empty = census([rowWithDeletes('empty.deep.test.js', [deleteOf('dynamic', [])])]);
  assert.equal(empty.counts.filesReachedByDynamicArm, 0, 'relations.length > 0 is part of the rule');
  assert.equal(empty.counts.filesReachedOnlyByDynamicArm, 0);
  assert.deepEqual(checkArtifactIntegrity(empty, { exists: allFilesExist }).failures, []);
});

test('an `unresolved` delete is neither arm, and makes the row `unknown`', () => {
  const record = rowWithDeletes('opaque.deep.test.js', [deleteOf('unresolved', [])]);
  record.unresolvedDynamicDeletes = 1;
  record.classification = impliedClassification(record);
  assert.equal(record.classification, 'unknown');
  const artifact = census([record]);
  assert.equal(artifact.counts.filesReachedByLiteralArm, 0);
  assert.equal(artifact.counts.filesReachedByDynamicArm, 0);
  assert.equal(artifact.counts.filesWithUnresolvedDynamicDelete, 1);
  // It is `unknown`, so the integrity gate refuses it outright.
  assert.ok(checkArtifactIntegrity(artifact, { exists: allFilesExist }).failures.some((item) => item.code === 'I2'));
});

test('each derived-counter family flips when a row is mutated', () => {
  // classification family
  const base = census(CLEAN());
  assert.equal(base.counts.classNone, 3);
  const moved = CLEAN();
  moved[0] = row('a.test.js', { b: true });
  assert.equal(census(moved).counts.classB, 1);
  // a/b flag family
  assert.equal(census(moved).counts.bUsers, 1);
  assert.equal(census([row('x.test.js', { a: true })]).counts.aUsers, 1);
  // delete-kind family
  assert.equal(census([rowWithDeletes('k.test.js', [deleteOf('literal', ['users'])])]).counts.filesReachedByLiteralArm, 1);
  assert.equal(census([rowWithDeletes('k.test.js', [deleteOf('dynamic', ['users'])])]).counts.filesReachedByLiteralArm, 0);
  // resolved-count field family
  const partialRow = row('p.test.js');
  partialRow.partiallyResolvedDynamicDeletes = 1;
  partialRow.classification = impliedClassification(partialRow);
  assert.equal(census([partialRow]).counts.filesWithPartiallyResolvedDynamicDelete, 1);
  // helper family (the record-scoped one, which IS derivable)
  const helperRow = row('h.test.js');
  helperRow.usesTenantTeardownHelper = true;
  assert.equal(census([helperRow]).counts.filesUsingHelperAndStillDeletingTargets, 1);
});

test('I6 the partition guard fires on a counts key in neither list', () => {
  const clean = census(CLEAN());
  assert.deepEqual(checkArtifactIntegrity(clean, { exists: allFilesExist }).failures, []);
  const extended = census(CLEAN());
  extended.counts.filesWithSomeNewIdea = 4;
  const result = checkArtifactIntegrity(extended, { exists: allFilesExist });
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].code, 'I6');
  assert.equal(result.failures[0].key, 'filesWithSomeNewIdea');
});

test('I6 also fires when a classified counter goes missing', () => {
  const missing = census(CLEAN());
  delete missing.counts.classBoth;
  const result = checkArtifactIntegrity(missing, { exists: allFilesExist });
  assert.ok(result.failures.some((item) => item.code === 'I6' && item.key === 'classBoth'));
});

test('I7 the walk-scoped counters are floors, and the helper counter is NOT derived', () => {
  // The real artifact records 12 helper users while files[] holds 1. An
  // equality check would redden it; the floor passes.
  const real = readCommitted();
  assert.equal(real.counts.filesUsingTenantTeardownHelper, 12);
  assert.equal(real.files.filter((record) => record.usesTenantTeardownHelper).length, 1);
  assert.deepEqual(checkArtifactIntegrity(real).failures, []);
  assert.ok(FLOOR_ONLY_COUNTS.includes('filesUsingTenantTeardownHelper'));
  assert.ok(!DERIVED_COUNTS.includes('filesUsingTenantTeardownHelper'));
  assert.ok(DERIVED_COUNTS.includes('filesUsingHelperAndStillDeletingTargets'));

  // Floors still bite when they are violated.
  const shallow = census(CLEAN(), { filesWalked: 12 });
  assert.ok(checkArtifactIntegrity(shallow, { exists: allFilesExist }).failures.some((item) => item.code === 'I7'));
  const noHelper = census(CLEAN(), { filesUsingTenantTeardownHelper: 0 });
  assert.ok(checkArtifactIntegrity(noHelper, { exists: allFilesExist }).failures.some((item) => item.code === 'I7'));
});

test('the partition covers every counter the real artifact carries, both ways', () => {
  const recorded = Object.keys(readCommitted().counts).sort();
  assert.deepEqual(recorded, [...ALL_COUNTS].sort());
  assert.equal(DERIVED_COUNTS.length + FLOOR_ONLY_COUNTS.length, ALL_COUNTS.length);
});
