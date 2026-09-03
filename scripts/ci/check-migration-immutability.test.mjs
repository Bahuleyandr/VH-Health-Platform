// Regression suite for the applied-migration immutability gate.
//   node --test scripts/ci/check-migration-immutability.test.mjs
//
// The controls that matter run the REAL CLI as a subprocess against a
// throwaway `git init` repository, so they exercise merge-base resolution,
// `git diff --raw` parsing and blob checksumming end to end rather than a
// unit-tested model of them. A unit test on the pure evaluator would happily
// pass while the git layer resolved the wrong base.
//
// The headline fixture is migration 566's ACTUAL 03db4c44f edit, copied blob
// for blob out of history. `fixture provenance` asserts the raw sha256 of both
// files, so if anyone ever "tidies" the fixtures the suite fails loudly instead
// of quietly testing a lookalike.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { evaluateMigrationChanges, parseAllowlist } from './check-migration-immutability.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const cli = join(here, 'check-migration-immutability.mjs');
const fixtures = join(here, 'fixtures', 'migration-immutability');

const MIGRATIONS_DIR = 'apps/backend/src/migrations';
const MIGRATION_566 = `${MIGRATIONS_DIR}/566_cath_consumables_billing_hook.sql`;

// Verified against the repository's own history on 2026-09-01:
//   git cat-file blob 03db4c44f^:<566>  → BEFORE
//   git cat-file blob 03db4c44f:<566>   → AFTER (still main's content)
// The rig recorded BEFORE, which is why it failed MIGRATION_CHECKSUM_DRIFT.
const BEFORE_SHA256 = '0a074114a0ee9587e7f37234d1648947a1a516352ada15b464576d9037d9bebe';
const AFTER_SHA256 = 'a39dc0ac0a0f1a26558f74f9902abb562aed87b4148e79963825b619229a9691';

const before = readFileSync(join(fixtures, '566_cath_consumables_billing_hook.before.sql'), 'utf8');
const after = readFileSync(join(fixtures, '566_cath_consumables_billing_hook.after.sql'), 'utf8');

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function writeFile(repo, relativePath, contents) {
  const absolute = join(repo, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function commit(repo, message) {
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--no-gpg-sign', '-q', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']).trim();
}

/**
 * A repo shaped like the real one at the merge-base: migration 566 present with
 * its ORIGINAL body, `main` recorded as `origin/main` exactly the way an
 * actions/checkout with fetch-depth: 0 leaves it, and the branch checked out.
 */
function seedRepo(t, { branch = 'feature', publishMain = true } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'vh-migration-guard-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  git(repo, ['init', '-q']);
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(repo, ['config', 'user.email', 'ci@vhhealth.test']);
  git(repo, ['config', 'user.name', 'VH CI']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  // The fixtures are LF; keep the synthetic repo from rewriting them so the
  // blob checksums stay comparable to the real ones.
  git(repo, ['config', 'core.autocrlf', 'false']);

  writeFile(repo, MIGRATION_566, before);
  writeFile(repo, `${MIGRATIONS_DIR}/565_prior_migration.sql`, 'SELECT 1;\n');
  const baseSha = commit(repo, 'base: migration 566 as shipped in #558');
  if (publishMain) git(repo, ['update-ref', 'refs/remotes/origin/main', baseSha]);

  git(repo, ['checkout', '-q', '-b', branch]);
  return { repo, baseSha };
}

function writeAllowlist(repo, amendments) {
  writeFile(repo, 'scripts/ci/migration-amendment-allowlist.json', `${JSON.stringify({ amendments }, null, 2)}\n`);
}

function runGate(repo, extraArgs = []) {
  const result = execFileSync(process.execPath, [cli, '--repo', repo, ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    // The gate exits 1 on a finding; that is the assertion, not a crash.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: 0, stdout: result, stderr: '' };
}

function runGateExpectingFailure(repo, extraArgs = []) {
  try {
    runGate(repo, extraArgs);
  } catch (error) {
    return { status: error.status, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
  return null;
}

const VALID_ENTRY = {
  file: MIGRATION_566,
  fromChecksum: BEFORE_SHA256,
  toChecksum: AFTER_SHA256,
  reason: 'Emergency correction agreed with the operator; a new migration cannot reach the affected rows.',
  runtimeRemediation: 'Operator reconciles the _migrations checksum row on every already-migrated database first.',
  approvedBy: 'Coordinator',
  approvedOn: '2026-08-30',
};

// ---------------------------------------------------------------------------
// Fixture provenance
// ---------------------------------------------------------------------------

test('fixture provenance: the fixtures are migration 566 byte-for-byte', () => {
  assert.equal(sha256(before), BEFORE_SHA256, 'before.sql is no longer the blob at 03db4c44f^');
  assert.equal(sha256(after), AFTER_SHA256, 'after.sql is no longer the blob at 03db4c44f');
  // The specific edit under test: an unconditional ALTER COLUMN wrapped in a
  // DO $$ ... IF ... atttypid <> 'bigint' ... guard.
  assert.match(before, /ALTER TABLE billing_invoice_items\s+ALTER COLUMN source_ref_id TYPE BIGINT/);
  assert.ok(!before.includes("atttypid <> 'bigint'::regtype"), 'before.sql already has the guard');
  assert.match(after, /atttypid <> 'bigint'::regtype/);
});

// ---------------------------------------------------------------------------
// The two directions the gate exists to distinguish
// ---------------------------------------------------------------------------

test('NEGATIVE CONTROL: fails on 03db4c44f\'s real in-place edit to migration 566', (t) => {
  const { repo } = seedRepo(t);
  writeFile(repo, MIGRATION_566, after);
  commit(repo, 'fix(ci): close medication workflow validation gaps');

  const failure = runGateExpectingFailure(repo);
  assert.ok(failure, 'the gate passed an edit to an already-applied migration');
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /566_cath_consumables_billing_hook\.sql — edited in place/);
  assert.match(failure.stderr, new RegExp(BEFORE_SHA256));
  assert.match(failure.stderr, new RegExp(AFTER_SHA256));
  assert.match(failure.stderr, /MIGRATION_CHECKSUM_DRIFT/);
  assert.match(failure.stderr, /add a NEW migration with the next free number/);
});

test('POSITIVE CONTROL: passes on a diff that only adds a new migration', (t) => {
  const { repo } = seedRepo(t);
  writeFile(repo, `${MIGRATIONS_DIR}/760_add_new_thing.sql`, 'ALTER TABLE demo ADD COLUMN IF NOT EXISTS note TEXT;\n');
  commit(repo, 'feat: add migration 760');

  const { status, stdout } = runGate(repo);
  assert.equal(status, 0);
  assert.match(stdout, /1 migration\(s\) added, 0 allowlisted amendment\(s\), 0 violation\(s\)/);
});

test('an added migration does not launder an edit in the same diff', (t) => {
  const { repo } = seedRepo(t);
  writeFile(repo, `${MIGRATIONS_DIR}/760_add_new_thing.sql`, 'SELECT 1;\n');
  writeFile(repo, MIGRATION_566, after);
  commit(repo, 'feat: add 760 and quietly amend 566');

  const failure = runGateExpectingFailure(repo);
  assert.ok(failure);
  assert.match(failure.stderr, /566_cath_consumables_billing_hook\.sql/);
});

test('deleting an already-applied migration is a violation', (t) => {
  const { repo } = seedRepo(t);
  rmSync(join(repo, MIGRATION_566));
  commit(repo, 'chore: drop 566');

  const failure = runGateExpectingFailure(repo);
  assert.ok(failure);
  assert.match(failure.stderr, /566_cath_consumables_billing_hook\.sql — deleted/);
  assert.match(failure.stderr, /\(file removed\)/);
});

test('a migration born on this branch may be edited on this branch', (t) => {
  // Merge-base semantics, not HEAD~1: 761 does not exist on main, so iterating
  // on it before merge is an ADD however many commits it takes.
  const { repo } = seedRepo(t);
  writeFile(repo, `${MIGRATIONS_DIR}/761_wip.sql`, 'SELECT 1;\n');
  commit(repo, 'feat: add 761');
  writeFile(repo, `${MIGRATIONS_DIR}/761_wip.sql`, 'SELECT 2;\n');
  commit(repo, 'fix: correct 761 before it ever ran anywhere');

  const { status, stdout } = runGate(repo);
  assert.equal(status, 0);
  assert.match(stdout, /1 migration\(s\) added, 0 allowlisted amendment\(s\), 0 violation\(s\)/);
});

test('a line-ending rewrite is not drift', (t) => {
  // The blob changes, the checksum does not. The repository LF-pins migration
  // checkouts, but historical blobs and tools that bypass attributes can still
  // produce CRLF. migrationChecksum() normalises it so that file still matches
  // every _migrations row on every database. This gate's authority rests on
  // mirroring the runtime check exactly, so it must not fail here.
  const { repo } = seedRepo(t);
  writeFile(repo, MIGRATION_566, before.replace(/\n/g, '\r\n'));
  commit(repo, 'chore: an editor rewrote 566 as CRLF');

  const { status, stdout } = runGate(repo);
  assert.equal(status, 0, 'a CRLF-only rewrite was reported as drift');
  assert.match(stdout, /1 migration\(s\) touched with no checksum change/);
  assert.match(stdout, /0 violation\(s\)/);
});

test('backend migrations resolve to an effective LF checkout policy', () => {
  const attributes = execFileSync(
    'git',
    ['check-attr', 'text', 'eol', '--', MIGRATION_566],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.match(attributes, /: text: set(?:\r?\n|$)/);
  assert.match(attributes, /: eol: lf(?:\r?\n|$)/);
});

test('the gate sources are free of NUL bytes', () => {
  // A stray NUL makes a source file "binary" to grep and to every grep-backed
  // review or CI gate downstream. Three of them shipped in this file's first
  // draft, as a template-literal separator, and behaved correctly enough that
  // all 21 tests passed without noticing.
  for (const file of [
    'scripts/ci/check-migration-immutability.mjs',
    'scripts/ci/check-migration-immutability.test.mjs',
    'scripts/ci/migration-amendment-allowlist.json',
  ]) {
    const bytes = readFileSync(join(repoRoot, file));
    assert.equal(bytes.indexOf(0), -1, `${file} contains a NUL byte at ${bytes.indexOf(0)}`);
  }
});

test('a non-.sql file in the migrations directory is not guarded', (t) => {
  const { repo } = seedRepo(t);
  writeFile(repo, `${MIGRATIONS_DIR}/README.md`, 'notes\n');
  commit(repo, 'docs: add a note');
  writeFile(repo, `${MIGRATIONS_DIR}/README.md`, 'more notes\n');
  commit(repo, 'docs: edit the note');

  assert.equal(runGate(repo).status, 0);
});

// ---------------------------------------------------------------------------
// The escape hatch
// ---------------------------------------------------------------------------

test('an allowlisted amendment passes and still warns about the runtime cost', (t) => {
  const { repo } = seedRepo(t);
  writeFile(repo, MIGRATION_566, after);
  writeAllowlist(repo, [VALID_ENTRY]);
  commit(repo, 'fix: approved in-place amendment to 566');

  const { status, stdout } = runGate(repo);
  assert.equal(status, 0);
  assert.match(stdout, /ALLOWLISTED AMENDMENT/);
  assert.match(stdout, /approved by Coordinator on 2026-08-30/);
  assert.match(stdout, /runtime checksum guard is NOT bypassed/);
  assert.match(stdout, /MIGRATION_CHECKSUM_DRIFT until an operator/);
});

test('an allowlist entry authorises one transition, not the file', (t) => {
  const { repo } = seedRepo(t);
  // Approved for BEFORE→AFTER, but the branch ships a third body.
  writeFile(repo, MIGRATION_566, `${after}\n-- a second, unreviewed edit\n`);
  writeAllowlist(repo, [VALID_ENTRY]);
  commit(repo, 'fix: sneak a further edit past the approved one');

  const failure = runGateExpectingFailure(repo);
  assert.ok(failure, 'a stale allowlist entry blessed content nobody approved');
  assert.match(failure.stderr, /566_cath_consumables_billing_hook\.sql/);
});

test('an inert allowlist entry neither fails nor authorises anything', (t) => {
  const { repo } = seedRepo(t);
  writeFile(repo, `${MIGRATIONS_DIR}/760_add_new_thing.sql`, 'SELECT 1;\n');
  writeAllowlist(repo, [VALID_ENTRY]);
  commit(repo, 'feat: add 760 while an old amendment entry sits in the allowlist');

  const { status, stdout } = runGate(repo);
  assert.equal(status, 0);
  assert.match(stdout, /1 allowlist entry\/entries are inert/);
});

test('a malformed allowlist fails the gate rather than reading as empty', (t) => {
  const { repo } = seedRepo(t);
  writeAllowlist(repo, [{ ...VALID_ENTRY, reason: 'typo' }]);
  commit(repo, 'chore: add an under-justified allowlist entry');

  const failure = runGateExpectingFailure(repo);
  assert.ok(failure, 'an invalid allowlist was tolerated');
  assert.match(failure.stderr, /allowlist is invalid/);
  assert.match(failure.stderr, /"reason" must be at least 40 characters/);
});

test('the checked-in allowlist is valid and, today, empty', () => {
  const raw = JSON.parse(readFileSync(join(repoRoot, 'scripts/ci/migration-amendment-allowlist.json'), 'utf8'));
  const { entries, errors } = parseAllowlist(raw);
  assert.deepEqual(errors, []);
  assert.equal(entries.length, 0, 'a new entry landed — it must be reviewed, not just parsed');
});

// ---------------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------------

test('an unresolvable merge-base fails the gate instead of skipping it', (t) => {
  const { repo } = seedRepo(t, { branch: 'orphan', publishMain: false });
  git(repo, ['branch', '-D', 'main']);
  writeFile(repo, MIGRATION_566, after);
  commit(repo, 'fix: edit 566 where no base ref can be resolved');

  const failure = runGateExpectingFailure(repo);
  assert.ok(failure, 'the gate silently passed when it could not resolve a base');
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /Unable to resolve a merge-base/);
  assert.match(failure.stderr, /fetch-depth: 0/);
});

test('a stale mirror remote cannot manufacture a violation', (t) => {
  // This repository has two remotes: `github` is the CI authority and `origin`
  // is a Forgejo mirror that lags — 11 commits behind when this gate was
  // written. A first-match base rule resolves the stale one on a dev box and
  // attributes everything main has landed since to the branch under test. That
  // is exactly how this gate's own first run reported migration 566 against a
  // branch that never touched it. The base must be the NEWEST common ancestor.
  const { repo, baseSha } = seedRepo(t, { branch: 'main-advance' });
  git(repo, ['checkout', '-q', 'main']);
  writeFile(repo, MIGRATION_566, after);
  const mainSha = commit(repo, 'main lands the 566 amendment');

  git(repo, ['update-ref', 'refs/remotes/origin/main', baseSha]); // stale mirror
  git(repo, ['update-ref', 'refs/remotes/github/main', mainSha]); // CI authority

  git(repo, ['checkout', '-q', '-b', 'feature']);
  writeFile(repo, `${MIGRATIONS_DIR}/760_add_new_thing.sql`, 'SELECT 1;\n');
  commit(repo, 'feat: add 760 on top of current main');

  const { status, stdout } = runGate(repo);
  assert.equal(status, 0, 'the stale mirror was used as the base');
  assert.match(stdout, /base github\/main/);
  assert.match(stdout, /newer than origin\/main/);
  assert.match(stdout, /1 migration\(s\) added, 0 allowlisted amendment\(s\), 0 violation\(s\)/);
});

test('GITHUB_BASE_REF and an explicit --base are both honoured', (t) => {
  const { repo, baseSha } = seedRepo(t);
  writeFile(repo, MIGRATION_566, after);
  commit(repo, 'fix: amend 566');
  git(repo, ['update-ref', 'refs/remotes/origin/release', baseSha]);

  const viaFlag = runGateExpectingFailure(repo, ['--base', 'origin/release']);
  assert.ok(viaFlag);
  assert.match(viaFlag.stderr, /566_cath_consumables_billing_hook\.sql/);
});

// ---------------------------------------------------------------------------
// Pure evaluator and allowlist validation
// ---------------------------------------------------------------------------

test('evaluateMigrationChanges classifies adds, amendments and violations', () => {
  const changes = [
    { file: `${MIGRATIONS_DIR}/760_new.sql`, status: 'A', fromChecksum: null, toChecksum: 'b'.repeat(64) },
    { file: MIGRATION_566, status: 'M', fromChecksum: BEFORE_SHA256, toChecksum: AFTER_SHA256 },
    { file: `${MIGRATIONS_DIR}/565_prior_migration.sql`, status: 'D', fromChecksum: 'c'.repeat(64), toChecksum: null },
  ];
  const result = evaluateMigrationChanges(changes, [VALID_ENTRY]);

  assert.equal(result.added.length, 1);
  assert.equal(result.amended.length, 1);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].status, 'D');
  assert.equal(result.inert.length, 0);
});

test('a deletion can be authorised with an explicit null toChecksum', () => {
  const entry = { ...VALID_ENTRY, file: `${MIGRATIONS_DIR}/565_prior_migration.sql`, fromChecksum: 'c'.repeat(64), toChecksum: null };
  const { errors } = parseAllowlist({ amendments: [entry] });
  assert.deepEqual(errors, []);

  const result = evaluateMigrationChanges(
    [{ file: `${MIGRATIONS_DIR}/565_prior_migration.sql`, status: 'D', fromChecksum: 'c'.repeat(64), toChecksum: null }],
    [entry],
  );
  assert.equal(result.violations.length, 0);
  assert.equal(result.amended.length, 1);
});

test('parseAllowlist rejects the ways an entry can be hollowed out', () => {
  const cases = [
    [{ ...VALID_ENTRY, reasons: 'typo in the key name' }, /unknown field "reasons"/],
    [{ ...VALID_ENTRY, fromChecksum: 'not-a-digest' }, /"fromChecksum" must be a 64-character/],
    [{ ...VALID_ENTRY, toChecksum: 'DEADBEEF' }, /"toChecksum" must be a 64-character/],
    [{ ...VALID_ENTRY, toChecksum: VALID_ENTRY.fromChecksum }, /authorises nothing/],
    [{ ...VALID_ENTRY, runtimeRemediation: 'n/a' }, /"runtimeRemediation" must be at least/],
    [{ ...VALID_ENTRY, approvedBy: '   ' }, /"approvedBy" must name the human/],
    [{ ...VALID_ENTRY, approvedOn: '30-08-2026' }, /"approvedOn" must be a YYYY-MM-DD date/],
    [{ ...VALID_ENTRY, file: 'apps/backend/src/services/billing.js' }, /must be a path under/],
  ];

  for (const [entry, expected] of cases) {
    const { errors } = parseAllowlist({ amendments: [entry] });
    assert.ok(errors.some((message) => expected.test(message)), `expected ${expected} in ${JSON.stringify(errors)}`);
  }

  const missing = parseAllowlist({ amendments: [{ file: MIGRATION_566 }] });
  assert.ok(missing.errors.some((message) => /missing required field "reason"/.test(message)));

  const duplicated = parseAllowlist({ amendments: [VALID_ENTRY, { ...VALID_ENTRY, approvedBy: 'Someone else' }] });
  assert.ok(duplicated.errors.some((message) => /duplicate entry/.test(message)));

  assert.ok(parseAllowlist([]).errors.some((message) => /expected a JSON object/.test(message)));
  assert.ok(parseAllowlist({}).errors.some((message) => /expected an "amendments" array/.test(message)));
});

// ---------------------------------------------------------------------------
// Wiring: the gate has to be somewhere it cannot be skipped
// ---------------------------------------------------------------------------

test('the gate is wired into the unconditional security stage', () => {
  const security = readFileSync(join(repoRoot, 'scripts/ci/security.mjs'), 'utf8');
  assert.match(security, /check-migration-immutability\.mjs/);

  const workflow = readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  // The security job must keep full history, or the gate fails closed on every run.
  const securityJob = workflow.slice(workflow.indexOf('\n  security:'), workflow.indexOf('\n  quick_backend:'));
  assert.match(securityJob, /fetch-depth: 0/);
  assert.match(workflow, /check-migration-immutability\.test\.mjs/);
});

test('the gate is mirrored into both backend tiers beside the other migration checks', () => {
  for (const file of [
    '.github/workflows/_reusable-backend-quick.yml',
    '.github/workflows/_reusable-backend-lint-test.yml',
  ]) {
    const workflow = readFileSync(join(repoRoot, file), 'utf8');
    assert.match(workflow, /check:migration-immutability/, `${file} does not run the gate`);
    assert.match(workflow, /check:migration-numbers/, `${file} lost the sibling migration check`);
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps/backend/package.json'), 'utf8'));
  assert.equal(
    pkg.scripts['check:migration-immutability'],
    'node ../../scripts/ci/check-migration-immutability.mjs',
  );
});

test('this branch passes its own gate', (t) => {
  // The gate has to be satisfiable on the branch that introduces it. Skipped
  // only in a checkout with no base ref at all (the fail-closed path is covered
  // above), so this never turns into a flake on a bare clone.
  const hasBase = ['origin/main', 'github/main', 'main'].some((ref) => {
    try {
      return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim() !== '';
    } catch {
      return false;
    }
  });
  if (!hasBase) return t.skip('no main ref in this checkout');

  const stdout = execFileSync(process.execPath, [cli], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(stdout, /0 violation\(s\)/);
});
