// Detector-capability probes for scripts/teardown-tx-census.mjs.
//
// Every probe mutates the fixture and asserts the classification MOVES. A probe
// that also passes on the unmodified fixture proves nothing, so each one names
// the baseline it is moving away from and the baseline is asserted first.
//
// TWO THINGS KEEP THIS FILE OUT OF ITS OWN CENSUS, and both are load-bearing.
// The census walks src/tests for /\.(js|mjs|cjs)$/ and scans string literals,
// so a file that spells the delete keyword in a literal becomes an entry in the
// artifact - a fabricated suite in a document whose whole point is an accurate
// population. Hence:
//   1. the fixture lives at fixtures/teardown-census/baseline-suite.js.txt, and
//   2. every synthetic statement below spells the keyword through DEL, which is
//      assembled at run time, so no literal in this file carries it contiguously.
// Verified: `node scripts/teardown-tx-census.mjs` lists neither this file nor
// the fixture.

import { readFileSync } from 'node:fs';
import { analyzeSource, census, PREDICATES, LIMITS, SCHEMA } from '../../../scripts/teardown-tx-census.mjs';

const FIXTURE = readFileSync(
  new URL('../fixtures/teardown-census/baseline-suite.js.txt', import.meta.url),
  'utf8',
);

// The delete keyword, assembled so this file's own source never contains it.
const DEL = ['DELETE', 'FROM'].join(' ');

const classify = (source) => analyzeSource(source, 'synthetic-fixture.js');

// Replace exactly once, and fail loudly when the anchor has drifted: a mutation
// that silently did not apply turns every probe below it into a tautology.
function mutate(source, anchor, replacement) {
  const occurrences = source.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(`fixture anchor appears ${occurrences} times, expected exactly 1: ${anchor}`);
  }
  return source.replace(anchor, replacement);
}

const PHASE_ONE_LOOP = [
  '    for (const table of EVIDENCE_TABLES) {',
  `      await tx.$executeRawUnsafe(\`${DEL} \${table} WHERE tenant_id = $1::uuid\`, TENANT);`,
  '    }',
].join('\n');
const REPLICA_RESET = "    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'origin'`);";
const PLAIN_DELETE = `    await tx.$executeRawUnsafe(\`${DEL} fixture_plain_rows WHERE tenant_id = $1::uuid\`, TENANT);`;
const LITERAL_USERS_DELETE = `    await tx.$executeRawUnsafe(\`${DEL} users WHERE tenant_id = $1::uuid\`, TENANT);`;
const DYNAMIC_USERS_LOOP = [
  "    for (const t of ['fixture_other_rows', 'users']) {",
  `      await tx.$executeRawUnsafe(\`${DEL} \${t} WHERE tenant_id = $1::uuid\`, TENANT);`,
  '    }',
].join('\n');

describe('teardown-tx-census detector capability', () => {
  // --- The baseline every probe moves away from. -----------------------------
  test('the unmutated fixture is class `none`, so every probe below is a real move', () => {
    const baseline = classify(FIXTURE);
    expect(baseline.classification).toBe('none');
    expect(baseline.a).toEqual({ users: false, tenants: false });
    expect(baseline.b).toEqual({ users: false, tenants: false });
    // It is `none` for the right reason, not because nothing was seen: the two
    // target deletes ARE found, at origin and outside every transaction.
    expect(baseline.deletes.map((item) => [item.relations[0], item.replica, item.inTransaction])).toEqual([
      ['users', 'outside', false],
      ['tenants', 'outside', false],
    ]);
    expect(baseline.hasReplicaWindow).toBe(true);
    expect(baseline.unresolvedDynamicDeletes).toBe(0);
    expect(baseline.partiallyResolvedDynamicDeletes).toBe(0);
  });

  // --- Probe (i): a literal users delete added inside the transaction. --------
  test('(i) a literal users delete added inside the transaction flips none -> b', () => {
    expect(classify(FIXTURE).classification).toBe('none');
    const result = classify(mutate(FIXTURE, PLAIN_DELETE, `${PLAIN_DELETE}\n${LITERAL_USERS_DELETE}`));
    expect(result.classification).toBe('b');
    expect(result.b).toEqual({ users: true, tenants: false });
    expect(result.deletes.some(
      (item) => item.kind === 'literal'
        && item.relations.includes('users')
        && item.replica === 'outside'
        && item.transactionVia === '$transaction',
    )).toBe(true);
  });

  // --- Probe (ii): a dynamic users delete added inside the replica window. ----
  test('(ii) a for-of loop over an array carrying `users` inside the replica window flips none -> a', () => {
    expect(classify(FIXTURE).classification).toBe('none');
    const result = classify(mutate(FIXTURE, PHASE_ONE_LOOP, `${PHASE_ONE_LOOP}\n${DYNAMIC_USERS_LOOP}`));
    expect(result.classification).toBe('a');
    expect(result.a).toEqual({ users: true, tenants: false });
    const hit = result.deletes.find((item) => item.kind === 'dynamic' && item.replica === 'inside');
    expect(hit).toBeDefined();
    expect(hit.relations).toEqual(['users']);
    // Two names resolved, one of them a target: the loop was read, not guessed.
    expect(hit.resolvedRelationCount).toBe(2);
  });

  // --- Probe (iii): the same delete moved out of the replica window. ----------
  test('(iii) moving that users delete out of the replica window flips a -> b', () => {
    const inside = classify(mutate(FIXTURE, PHASE_ONE_LOOP, `${PHASE_ONE_LOOP}\n${DYNAMIC_USERS_LOOP}`));
    expect(inside.classification).toBe('a');

    // Byte-identical statement, same transaction, moved after the 'origin'
    // reset. Only which side of the toggle it sits on has changed.
    const result = classify(mutate(FIXTURE, REPLICA_RESET, `${REPLICA_RESET}\n${DYNAMIC_USERS_LOOP}`));
    expect(result.classification).toBe('b');
    expect(result.a).toEqual({ users: false, tenants: false });
    expect(result.b).toEqual({ users: true, tenants: false });
    expect(result.deletes.find((item) => item.kind === 'dynamic').replica).toBe('outside');
  });

  // --- Probe (iv): the window CLOSES. This is the false mitigation the --------
  // --- 2026-09-08 census made: `replica` present in the file read as safe. ----
  test('(iv) a delete after the `origin` reset is outside the window, not mitigated by it', () => {
    const withReset = mutate(FIXTURE, PLAIN_DELETE, `${PLAIN_DELETE}\n${LITERAL_USERS_DELETE}`);
    expect(classify(withReset).classification).toBe('b');

    // Remove the reset and the identical statement is now inside the window.
    // The window's END decides, not the file containing the word `replica`.
    const withoutReset = classify(mutate(withReset, `${REPLICA_RESET}\n`, ''));
    expect(withoutReset.classification).toBe('a');
    expect(withoutReset.a).toEqual({ users: true, tenants: false });
  });

  // --- Probe (v): an unreadable loop source must NOT read as clean. -----------
  test('(v) a loop over a source declared outside the file is `unknown`, never `none`', () => {
    expect(classify(FIXTURE).classification).toBe('none');
    const mutated = mutate(FIXTURE, PHASE_ONE_LOOP, [
      PHASE_ONE_LOOP,
      '    for (const t of tablesFromSomeConfigModule) {',
      `      await tx.$executeRawUnsafe(\`${DEL} \${t} WHERE tenant_id = $1::uuid\`, TENANT);`,
      '    }',
    ].join('\n'));
    const result = classify(mutated);
    expect(result.classification).toBe('unknown');
    expect(result.unresolvedDynamicDeletes).toBe(1);
    const unreadable = result.deletes.find((item) => item.kind === 'unresolved');
    expect(unreadable.binding).toContain('tablesFromSomeConfigModule');
    expect(unreadable.relations).toEqual([]);
  });

  // --- Probe (vi): partial resolution keeps its hits and keeps its doubt. -----
  test('(vi) a spread of an unreadable name still yields the literal `users` beside it', () => {
    const mutated = mutate(FIXTURE, PHASE_ONE_LOOP, [
      PHASE_ONE_LOOP,
      "    for (const t of [...tablesFromSomeConfigModule, 'users']) {",
      `      await tx.$executeRawUnsafe(\`${DEL} \${t} WHERE tenant_id = $1::uuid\`, TENANT);`,
      '    }',
    ].join('\n'));
    const result = classify(mutated);
    expect(result.classification).toBe('a');
    expect(result.partiallyResolvedDynamicDeletes).toBe(1);
    const partial = result.deletes.find((item) => item.kind === 'dynamic-partial');
    expect(partial.relations).toEqual(['users']);
    expect(partial.binding).toContain('partially resolved');
  });

  // --- Probe (vii): the two constructions the corpus actually uses. -----------
  test('(vii) Object.freeze arrays and array-pattern for-of bindings resolve', () => {
    const frozen = classify([
      "import prisma from '../../lib/prisma.js';",
      "const PURGE = Object.freeze(['fixture_rows', 'users']);",
      'export async function purge(tenant) {',
      '  await prisma.$transaction(async (tx) => {',
      "    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);",
      '    for (const table of PURGE) {',
      `      await tx.$executeRawUnsafe(\`${DEL} \${table} WHERE tenant_id = $1::uuid\`, tenant);`,
      '    }',
      '  });',
      '}',
    ].join('\n'));
    expect(frozen.classification).toBe('a');
    expect(frozen.deletes[0].kind).toBe('dynamic');
    expect(frozen.deletes[0].relations).toEqual(['users']);

    const destructured = classify([
      "import prisma from '../../lib/prisma.js';",
      'export async function purge(tenant) {',
      "  for (const [table, column] of [['fixture_rows', 'tenant_id'], ['users', 'tenant_id']]) {",
      `    await prisma.$executeRawUnsafe(\`${DEL} \${table} WHERE \${column} = $1::uuid\`, tenant);`,
      '  }',
      '}',
    ].join('\n'));
    expect(destructured.deletes[0].kind).toBe('dynamic');
    expect(destructured.deletes[0].relations).toEqual(['users']);
    expect(destructured.classification).toBe('none');
  });

  // --- Probe (viii): one hop of same-file wrapper is followed. ----------------
  test('(viii) a users delete behind a same-file transaction wrapper is still inTransaction', () => {
    const result = classify([
      "import prisma from '../../lib/prisma.js';",
      'function inTx(work) {',
      '  return prisma.$transaction(async (tx) => work(tx));',
      '}',
      'export async function purge(tenant) {',
      '  await inTx(async (tx) => {',
      `    await tx.$executeRawUnsafe(\`${DEL} users WHERE tenant_id = $1::uuid\`, tenant);`,
      '  });',
      '}',
    ].join('\n'));
    expect(result.localWrappers).toContain('inTx');
    expect(result.classification).toBe('b');
    expect(result.deletes[0].transactionVia).toBe('local-wrapper:inTx');
  });
});

describe('teardown-tx-census over the real corpus', () => {
  // Not a pin: no expected file list and no expected count, because the
  // five-suite conversion programme is changing these files. What is asserted
  // is that the census MEASURED something - an arm that silently reads zero is
  // the failure mode this whole census exists to correct.
  test('the corpus census parses every file and reports a non-empty population', () => {
    const data = census();
    expect(data.schema).toBe(SCHEMA);
    expect(data.parseFailures).toEqual([]);
    expect(data.counts.filesWalked).toBeGreaterThan(1500);
    expect(data.counts.filesWithTargetDelete).toBeGreaterThan(100);
    // Both arms must reach something. A dynamic count of 0 was a real defect
    // during development: a stray reference made every dynamic-arm file throw,
    // the throw was swallowed as a "parse failure", and the dynamic arm read 0.
    expect(data.counts.filesReachedByLiteralArm).toBeGreaterThan(0);
    expect(data.counts.filesReachedByDynamicArm).toBeGreaterThan(0);
    expect(data.counts.classA + data.counts.classBoth).toBeGreaterThan(0);
    expect(data.counts.classB + data.counts.classBoth).toBeGreaterThan(0);
    // This file and its fixture must not appear in the corpus census: a probe
    // suite counted as a real one would put a fabricated row in the artifact.
    expect(data.files.map((item) => item.file).filter((file) => file.includes('teardown-census')
      || file.endsWith('unit/teardownTxCensus.test.js'))).toEqual([]);
    // Every count carries its predicate, and every predicate is non-empty.
    for (const [name, text] of Object.entries(PREDICATES)) {
      expect(typeof text === 'string' && text.length > 40).toBe(true);
      expect(data.predicates[name]).toBe(text);
    }
    expect(data.limits).toEqual(LIMITS);
    expect(data.limits.length).toBeGreaterThan(5);
  });
});
