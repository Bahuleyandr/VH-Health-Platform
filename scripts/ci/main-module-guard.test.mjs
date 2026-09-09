// Regression suite for the `pathToFileURL(process.argv[1])` main-module idiom.
//   node --test scripts/ci/main-module-guard.test.mjs
//
// The idiom decides "am I the entry point?" by comparing this module's URL with
// the URL of the script node was told to run. `process.argv[1]` is only defined
// for a CLI invocation: under `node -e`, inside a worker thread, and in any
// editor or tool that walks the module graph it is `undefined`, and
// `pathToFileURL(undefined)` throws
//   TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string.
// The throw happens while the module is still evaluating, so the module cannot
// be imported as a library AT ALL — every named export it offers is
// unreachable. That is not hypothetical: a session reusing
// `resolveMergeBase` out of check-migration-immutability.mjs hit exactly this
// and had to route around the file rather than import it.
//
// The controls here are BEHAVIOURAL, not textual. A regex that classifies each
// hit as guarded/unguarded would have to model four different spellings of the
// guard already in the tree (inline, reversed operands, multi-line `if`, and a
// `const` binding) and would quietly mis-file a fifth. So instead every hit the
// sweep predicate finds is actually imported in a subprocess whose
// `process.argv[1]` is undefined, and the subprocess is asked to prove that
// precondition about itself before it imports anything.
//
// `guard is load-bearing` is the half that fails on the pre-fix tree: it
// reconstructs the unguarded shape from each fixed file's own current bytes and
// asserts the throw still happens without the guard. Without that arm this
// suite would be a test that only ever passes.

import { spawnSync, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

// The sweep predicate, verbatim:
//   git grep -n "pathToFileURL(process.argv\[1\])" -- scripts apps
const SWEEP_NEEDLE = 'pathToFileURL(process.argv[1])';
const SWEEP_PATHSPECS = ['scripts', 'apps'];

// The canonical guarded and unguarded spellings. Pinned in both directions so a
// rewrite of the guard fails this suite loudly instead of silently disabling
// the mutation arm below.
const GUARDED_LINE = 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {';
const UNGUARDED_LINE = 'if (import.meta.url === pathToFileURL(process.argv[1]).href) {';

// This suite is itself a member of the census: it quotes the idiom in
// SWEEP_NEEDLE, GUARDED_LINE and UNGUARDED_LINE. Importing it re-enters the
// test runner, which sweeps and imports itself again, and recurses until the
// probe timeout. That is not hypothetical either — it is what the first
// commit of this file did on CI, because `git grep` searches only TRACKED
// files and the local run that reported 5/5 green was taken while this file
// was still untracked.
//
// The counts, each tied to the commit it was measured at, because a census
// size is history and not a standing fact:
//   github/main 30c6520b5 ..... 17   (what the local pre-commit run measured)
//   03d8765b2 ................. 19   (what the recursing CI run swept: +this
//                                     file, +security.mjs, whose first wiring
//                                     comment quoted the needle too)
//   668f561e2 onwards ......... 18   (security.mjs's comment rephrased to
//                                     `pathToFileURL(argv[1])`, dropping it
//                                     back out; this file stays, excluded)
// Reproduce any row with:
//   git grep -l --fixed-strings 'pathToFileURL(process.argv[1])' <rev> -- scripts apps | wc -l
//
// So this one path is excluded from the import probe. The exclusion is PROVEN
// sound by `this suite quotes the idiom without ever executing it` below
// rather than assumed: every line here that carries the needle has to be a
// comment or one of the three pinned constants.
const SELF = 'scripts/ci/main-module-guard.test.mjs';

// The five files this suite's fix guarded. Each one threw on import before the
// fix; see the PR body for the pre-fix census.
const FIXED_BY_THIS_CHANGE = [
  'apps/device-gateway/scripts/soak-replay.mjs',
  'scripts/ci/assert-canonical-results.mjs',
  'scripts/ci/canonical-plan.mjs',
  'scripts/ci/check-migration-immutability.mjs',
  'scripts/ci/run-affected-backend-tests.mjs',
];

// Sweep hits whose module graph reaches a third-party package (`pg`, `jose`).
// The security stage runs with no `npm ci`, so importing these fails with
// ERR_MODULE_NOT_FOUND there and succeeds on a dev box that has installed the
// backend. Both outcomes are accepted for these four paths — and ONLY the
// module-resolution failure is accepted, never the argv TypeError, which is
// asserted against every hit regardless of which list it is on.
const MAY_FAIL_ON_MISSING_DEPS = new Set([
  'apps/backend/scripts/audit-care-team-enforcement-readiness.mjs',
  'apps/backend/scripts/payroll-revision-754-preflight.mjs',
  'apps/backend/scripts/reconcile-clinical-ai-catalog.mjs',
  'apps/backend/scripts/test/nhcx-mock-exchange.mjs',
]);

// The defect signature. Matched against the child's stderr.
const DEFECT_SIGNATURE = /The "path" argument must be of type string\. Received undefined/;

// Run in a child whose process.argv[1] is undefined (`node -e` never sets it).
// The child asserts that precondition about ITSELF first: if a future node ever
// populates argv[1] under -e, this suite fails loudly rather than passing
// because it stopped reproducing the condition it exists to test.
const PROBE = [
  "import { pathToFileURL } from 'node:url';",
  "if (process.argv[1] !== undefined) {",
  "  console.error('PROBE_PRECONDITION_LOST argv1=' + String(process.argv[1]));",
  "  process.exit(97);",
  "}",
  "await import(pathToFileURL(process.env.PROBE_TARGET).href);",
  "console.log('PROBE_IMPORT_OK');",
].join('\n');

function probeImport(absolutePath) {
  // 60s is ~60x the slowest legitimate import here. A probe that reaches the
  // cap is reported as a timeout rather than as `exit null`, because the one
  // way this suite has actually failed was a self-import recursion that ran
  // until the cap.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PROBE_TARGET: absolutePath },
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  assert.ok(
    !/PROBE_PRECONDITION_LOST/.test(stderr),
    `the probe no longer reproduces an undefined process.argv[1]: ${stderr.trim()}`,
  );
  const timedOut = result.status === null;
  return {
    status: result.status,
    timedOut,
    stdout,
    stderr,
    failureSummary: timedOut ? 'timed out after 60s (import never settled)' : `exit ${result.status}`,
    stdoutLines: stdout.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

function sweep() {
  // `git grep -l` over the working tree, same needle and same pathspecs as the
  // documented sweep. Fixed-string, so the bracket has no regex meaning.
  const out = execFileSync(
    'git',
    ['grep', '-l', '--fixed-strings', SWEEP_NEEDLE, '--', ...SWEEP_PATHSPECS],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  return out.split('\n').map((line) => line.trim()).filter(Boolean).sort();
}

// ---------------------------------------------------------------------------
// Census: the population this suite measures must be non-empty and must
// actually contain the files the fix touched.
// ---------------------------------------------------------------------------

test('the sweep predicate yields a non-empty census that covers every fixed file', () => {
  const files = sweep();

  assert.ok(
    files.length > 0,
    `sweep for ${SWEEP_NEEDLE} under ${SWEEP_PATHSPECS.join(', ')} found nothing — ` +
      'the predicate, not the tree, is what changed',
  );

  for (const file of FIXED_BY_THIS_CHANGE) {
    assert.ok(files.includes(file), `${file} dropped out of the sweep census`);
  }
  for (const file of MAY_FAIL_ON_MISSING_DEPS) {
    assert.ok(files.includes(file), `${file} dropped out of the sweep census`);
  }

  // The excluded path has to still BE in the census. If this file is renamed
  // and SELF is not updated, the exclusion below would silently stop matching
  // and the recursion would come straight back; this fails first instead.
  assert.ok(
    files.includes(SELF),
    `${SELF} is not in the census — SELF is stale and the probe exclusion no longer matches`,
  );

  // Everything on the pinned lists is a subset of the census; the census is
  // allowed to grow, and any new member is covered by the next test.
  assert.ok(files.length >= FIXED_BY_THIS_CHANGE.length + MAY_FAIL_ON_MISSING_DEPS.size + 1);
});

test('this suite quotes the idiom without ever executing it', () => {
  // Justifies the one exclusion in the probe below. If this file ever gains a
  // real main-module check, excluding it from the census would be hiding a
  // genuine instance — so the shape of every needle-bearing line is pinned.
  const source = readFileSync(join(repoRoot, SELF), 'utf8');
  const bearing = source
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => entry.line.includes(SWEEP_NEEDLE));

  assert.ok(bearing.length > 0, `${SELF} no longer quotes the sweep needle at all`);

  const allowed = /^(\s*\/\/|const (SWEEP_NEEDLE|GUARDED_LINE|UNGUARDED_LINE) = )/;
  const offending = bearing
    .filter((entry) => !allowed.test(entry.line))
    .map((entry) => `${SELF}:${entry.number}: ${entry.line.trim()}`);

  assert.deepEqual(
    offending,
    [],
    `${SELF} carries the idiom outside a comment or a pinned constant, so ` +
      'excluding it from the import probe would hide a real instance',
  );
});

test('the counts this suite states in prose match the lists they describe', () => {
  // Review of the first draft found a comment reading "accepted for these five
  // paths" over a Set of FOUR — a number recalled rather than counted, in the
  // one file whose whole thesis is that a claim which merely SOUNDS like a
  // measurement is how a defect survives a reader. Nothing asserted it, so
  // nothing could catch it. This does.
  //
  // Only the counts that are derivable from a live data structure are gated
  // here. The census sizes in the SELF comment above are historical facts about
  // three specific commits; they carry the command that reproduces each row
  // instead, because pinning them to SHAs would break the moment this branch is
  // squashed onto main.
  const source = readFileSync(join(repoRoot, SELF), 'utf8');
  const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

  const cases = [
    {
      what: 'FIXED_BY_THIS_CHANGE',
      pattern: /^\/\/ The (\w+) files this suite's fix guarded/m,
      actual: FIXED_BY_THIS_CHANGE.length,
    },
    {
      what: 'MAY_FAIL_ON_MISSING_DEPS',
      pattern: /^\/\/ backend\. Both outcomes are accepted for these (\w+) paths/m,
      actual: MAY_FAIL_ON_MISSING_DEPS.size,
    },
  ];

  for (const { what, pattern, actual } of cases) {
    const match = source.match(pattern);
    assert.ok(match, `the prose describing ${what} was reworded; this gate no longer reads it`);
    assert.equal(
      match[1],
      WORDS[actual],
      `the comment says "${match[1]}" but ${what} has ${actual} entr${actual === 1 ? 'y' : 'ies'}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The invariant: no main-module check may throw when there is no script argument
// ---------------------------------------------------------------------------

test('every module in the census imports with no script argument', () => {
  const census = sweep();
  const probed = census.filter((file) => file !== SELF);
  const clean = [];
  const depFailures = [];
  const offenders = [];

  for (const file of probed) {
    const probe = probeImport(join(repoRoot, file));

    // Arm 1, applied to EVERY hit including the dependency-tolerant ones: the
    // defect signature must not appear.
    if (DEFECT_SIGNATURE.test(probe.stderr)) {
      const signature = probe.stderr
        .split('\n')
        .map((line) => line.trim())
        .find((line) => DEFECT_SIGNATURE.test(line));
      offenders.push(`${file}: unguarded main-module check — ${signature}`);
      continue;
    }

    // Arm 2: a clean import, proven by the child's own stdout. `PROBE_IMPORT_OK`
    // has to be the ONLY thing the child printed — if the CLI body ran it would
    // have printed its own output, or called process.exit() and swallowed the
    // sentinel entirely.
    if (probe.status === 0) {
      assert.deepEqual(
        probe.stdoutLines,
        ['PROBE_IMPORT_OK'],
        `${file} printed CLI output on a plain import; the main-module body executed`,
      );
      clean.push(file);
      continue;
    }

    if (MAY_FAIL_ON_MISSING_DEPS.has(file) && /ERR_MODULE_NOT_FOUND/.test(probe.stderr)) {
      depFailures.push(file);
      continue;
    }

    offenders.push(`${file}: ${probe.failureSummary}\n${probe.stderr.trim()}`);
  }

  assert.deepEqual(offenders, [], `main-module checks that break a plain import:\n${offenders.join('\n')}`);

  // Population guard: a broken sweep or a broken probe would leave `clean`
  // empty and every assertion above vacuously true.
  assert.ok(
    clean.length >= FIXED_BY_THIS_CHANGE.length,
    `only ${clean.length} module(s) imported cleanly; expected at least the ` +
      `${FIXED_BY_THIS_CHANGE.length} files this change fixed`,
  );
  for (const file of FIXED_BY_THIS_CHANGE) {
    assert.ok(clean.includes(file), `${file} did not import cleanly`);
  }

  // Every probed member landed in exactly one bucket, and the only census
  // member not probed is the pinned self-exclusion.
  assert.equal(clean.length + depFailures.length, probed.length);
  assert.equal(probed.length + 1, census.length);
});

// ---------------------------------------------------------------------------
// The half that fails on the pre-fix tree
// ---------------------------------------------------------------------------

test('guard is load-bearing: stripping it reproduces the throw on every fixed file', () => {
  const proven = [];

  for (const file of FIXED_BY_THIS_CHANGE) {
    const absolute = join(repoRoot, file);
    const original = readFileSync(absolute, 'utf8');

    assert.equal(
      original.split(GUARDED_LINE).length - 1,
      1,
      `${file} no longer carries exactly one canonical guarded main-module check`,
    );

    const mutated = original.replace(GUARDED_LINE, UNGUARDED_LINE);
    // Strip-and-compare: the mutation has to have actually removed something.
    assert.notEqual(mutated, original, `mutation of ${file} was a no-op`);
    assert.ok(mutated.includes(UNGUARDED_LINE), `mutant of ${file} lacks the unguarded shape`);

    // The mutant lives beside the original so its relative imports still
    // resolve; every one of these five reaches at least one sibling module.
    const mutantPath = join(dirname(absolute), `main-module-guard-mutant-${process.pid}.mjs`);
    try {
      writeFileSync(mutantPath, mutated);
      const probe = probeImport(mutantPath);
      assert.notEqual(probe.status, 0, `unguarded ${file} imported cleanly — the defect is not reproduced`);
      assert.match(
        probe.stderr,
        DEFECT_SIGNATURE,
        `unguarded ${file} failed for some other reason:\n${probe.stderr.trim()}`,
      );
      proven.push(file);
    } finally {
      rmSync(mutantPath, { force: true });
    }
  }

  assert.deepEqual(proven, FIXED_BY_THIS_CHANGE);
});

// ---------------------------------------------------------------------------
// The guard must not change CLI behaviour
// ---------------------------------------------------------------------------

test('the guarded shape still runs the CLI body when invoked as a script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'main-module-guard-'));
  try {
    const fixture = join(dir, 'fixture.mjs');
    writeFileSync(
      fixture,
      [
        "import { pathToFileURL } from 'node:url';",
        '',
        GUARDED_LINE,
        "  console.log('CLI_BODY_RAN');",
        '}',
        '',
      ].join('\n'),
    );

    // Invoked as a script: argv[1] is the fixture, the guard is true, body runs.
    const asScript = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(asScript.status, 0, asScript.stderr);
    assert.match(asScript.stdout, /CLI_BODY_RAN/);

    // Imported with no script argument: no throw, and the body stays inert.
    const asImport = probeImport(fixture);
    assert.equal(asImport.status, 0, asImport.stderr);
    assert.deepEqual(asImport.stdoutLines, ['PROBE_IMPORT_OK']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Wiring: this suite has to run somewhere the planner cannot skip
// ---------------------------------------------------------------------------

test('this suite is wired into the unconditional security stage', () => {
  const security = readFileSync(join(repoRoot, 'scripts', 'ci', 'security.mjs'), 'utf8');
  assert.match(
    security,
    /'--test', 'scripts\/ci\/main-module-guard\.test\.mjs'/,
    'scripts/ci/security.mjs no longer runs this suite',
  );

  // The security stage is the one stage every canonical plan selects, and
  // ci.yml reaches it through run.mjs --only=security.
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /node scripts\/ci\/run\.mjs --only=security/);
});
