import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  evaluateDatabaseCalibration,
  evaluateStaticCensus,
  manifestPath,
  migrationsDir,
  renderTableReport,
  scanInlineChecks,
} from './check-inline-check-census.mjs';

// An inline CHECK inside `CREATE TABLE IF NOT EXISTS <t>` where <t> already
// exists from 000_baseline.sql never reaches the database. The gate keeps a
// pinned census of those clauses, fails when the census grows or a declared
// constraint disappears, lets the census shrink when a forward migration adds
// the constraint for real, and calibrates the static classification against
// pg_constraint in both directions.

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

const BASELINE = `--
-- fixture baseline (pg_dump shape)
--
CREATE TABLE public.alpha (
    id integer NOT NULL,
    status character varying(20) NOT NULL,
    kind character varying(20),
    CONSTRAINT alpha_kind_check CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))
);
CREATE TABLE public.beta (
    id integer NOT NULL,
    mode character varying(20) NOT NULL
);
`;

const REDECLARE = `BEGIN;
-- re-declares two baseline-owned tables: alpha keeps kind, loses status; beta loses mode
CREATE TABLE IF NOT EXISTS alpha (
  id     INTEGER PRIMARY KEY,
  status VARCHAR(20) NOT NULL CHECK (status IN ('open', 'closed')),
  kind   VARCHAR(20) CHECK (kind IN ('a', 'b'))
);
CREATE TABLE IF NOT EXISTS beta (
  id   INTEGER PRIMARY KEY,
  mode VARCHAR(20) NOT NULL,
  CONSTRAINT beta_mode_ck CHECK (mode IN ('x', 'y'))
);
COMMIT;
`;

const FRESH = `CREATE TABLE gamma (
  id INTEGER PRIMARY KEY,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  -- a comment with CHECK (ignored) and a 'string with CHECK (' inside
  note TEXT DEFAULT 'CHECK (not a constraint)'
);
`;

function fixtureCorpus(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'inline-check-census-'));
  const migrations = join(dir, 'migrations');
  mkdirSync(migrations);
  writeFileSync(join(migrations, '000_baseline.sql'), BASELINE);
  writeFileSync(join(migrations, '010_redeclare.sql'), REDECLARE);
  writeFileSync(join(migrations, '020_fresh.sql'), FRESH);
  for (const [name, sql] of Object.entries(extra)) writeFileSync(join(migrations, name), sql);
  return { dir, migrations };
}

// pg_constraint as CI would see it for the fixture: alpha kept its kind check
// (the baseline carried it), status and mode were lost, gamma's own check exists.
const FIXTURE_CONSTRAINTS = [
  { table: 'alpha', conname: 'alpha_kind_check', definition: "CHECK (((kind)::text = ANY ((ARRAY['a'::character varying, 'b'::character varying])::text[])))" },
  { table: 'gamma', conname: 'gamma_level_check', definition: 'CHECK (((level >= 1) AND (level <= 5)))' },
];

function fixtureManifest(migrations, constraints = FIXTURE_CONSTRAINTS) {
  const { census } = scanInlineChecks({ migrationsDir: migrations });
  return buildManifest({
    census,
    constraintRows: constraints,
    evidence: { generatedFromHead: 'f'.repeat(40), ledger: 'docs/FULL_REPOSITORY_AUDIT_2026_08.md' },
  });
}

test('the scanner finds inline CHECKs, skips comments and strings, and censuses only re-declarations of baseline-owned tables', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const { inventory, census, baselineTables } = scanInlineChecks({ migrationsDir: migrations });
    assert.deepEqual([...baselineTables].sort(), ['alpha', 'beta']);
    assert.equal(inventory.length, 4, 'alpha.status, alpha.kind, beta.mode, gamma.level');
    assert.deepEqual(
      census.map((entry) => `${entry.file}#${entry.table}#${entry.constraintName}`),
      [
        '010_redeclare.sql#alpha#alpha_status_check',
        '010_redeclare.sql#alpha#alpha_kind_check',
        '010_redeclare.sql#beta#beta_mode_ck',
      ],
    );
    const gamma = inventory.find((entry) => entry.table === 'gamma');
    assert.equal(gamma.constraintName, 'gamma_level_check');
    assert.equal(gamma.clause, 'level BETWEEN 1 AND 5');
    assert.equal(gamma.inCensus, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the manifest records which census clauses the database actually enforces', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const manifest = fixtureManifest(migrations);
    assert.equal(manifest.expectedAbsentCount, 2);
    assert.deepEqual(
      manifest.entries.map((entry) => [entry.constraintName, entry.enforced]),
      [['alpha_status_check', false], ['alpha_kind_check', true], ['beta_mode_ck', false]],
    );
    assert.match(manifest.entries[0].clauseSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(evaluateStaticCensus({ migrationsDir: migrations, manifest }), []);
    assert.deepEqual(evaluateDatabaseCalibration({ manifest, constraintRows: FIXTURE_CONSTRAINTS }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removing a satisfied inline CHECK from an applied migration is detected', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const manifest = fixtureManifest(migrations);
    writeFileSync(join(migrations, '010_redeclare.sql'), REDECLARE.replace("  kind   VARCHAR(20) CHECK (kind IN ('a', 'b'))\n", '  kind   VARCHAR(20)\n'));
    const violations = evaluateStaticCensus({ migrationsDir: migrations, manifest });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /removed.*010_redeclare\.sql.*alpha_kind_check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new inline CHECK in a re-declaration of a baseline-owned table is detected, one on a fresh table is not', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const manifest = fixtureManifest(migrations);
    writeFileSync(
      join(migrations, '030_more.sql'),
      "CREATE TABLE IF NOT EXISTS beta (\n  id INTEGER PRIMARY KEY,\n  mode VARCHAR(20) CHECK (mode <> 'z')\n);\nCREATE TABLE IF NOT EXISTS delta (\n  id INTEGER PRIMARY KEY,\n  tone TEXT CHECK (tone IN ('warm', 'cold'))\n);\n",
    );
    const violations = evaluateStaticCensus({ migrationsDir: migrations, manifest });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /new inline CHECK.*030_more\.sql.*beta.*beta_mode_check/);
    assert.match(violations[0], /ALTER TABLE/);
    assert.doesNotMatch(violations[0], /delta/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an edited clause is detected through its digest', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const manifest = fixtureManifest(migrations);
    writeFileSync(join(migrations, '010_redeclare.sql'), REDECLARE.replace("('open', 'closed')", "('open', 'closed', 'void')"));
    const violations = evaluateStaticCensus({ migrationsDir: migrations, manifest });
    assert.equal(violations.length, 1);
    assert.match(violations[0], /changed.*alpha_status_check/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shrinking the census without a real fix is detected', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const manifest = fixtureManifest(migrations);
    const decremented = { ...manifest, expectedAbsentCount: manifest.expectedAbsentCount - 1 };
    assert.match(evaluateStaticCensus({ migrationsDir: migrations, manifest: decremented })[0], /expectedAbsentCount/);
    const deleted = { ...manifest, entries: manifest.entries.filter((entry) => entry.constraintName !== 'beta_mode_ck') };
    assert.match(evaluateStaticCensus({ migrationsDir: migrations, manifest: deleted })[0], /new inline CHECK.*beta_mode_ck/);
    const flipped = {
      ...manifest,
      expectedAbsentCount: 1,
      entries: manifest.entries.map((entry) => (entry.constraintName === 'beta_mode_ck' ? { ...entry, enforced: true } : entry)),
    };
    assert.deepEqual(evaluateStaticCensus({ migrationsDir: migrations, manifest: flipped }), [], 'statically consistent');
    const discrepancies = evaluateDatabaseCalibration({ manifest: flipped, constraintRows: FIXTURE_CONSTRAINTS });
    assert.equal(discrepancies.length, 1);
    assert.match(discrepancies[0], /beta_mode_ck.*marked enforced.*absent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a genuinely fixed constraint lets the census shrink cleanly, and calibration is checked in both directions', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const manifest = fixtureManifest(migrations);
    const fixedRows = [...FIXTURE_CONSTRAINTS, { table: 'beta', conname: 'beta_mode_ck', definition: "CHECK (((mode)::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))" }];
    // Before the manifest is updated, calibration reports the other direction.
    const stale = evaluateDatabaseCalibration({ manifest, constraintRows: fixedRows });
    assert.equal(stale.length, 1);
    assert.match(stale[0], /beta_mode_ck.*marked absent.*present/);
    // The remediation PR flips the entry and decrements the count: green on both halves.
    const fixed = {
      ...manifest,
      expectedAbsentCount: 1,
      entries: manifest.entries.map((entry) => (entry.constraintName === 'beta_mode_ck' ? { ...entry, enforced: true } : entry)),
    };
    assert.deepEqual(evaluateStaticCensus({ migrationsDir: migrations, manifest: fixed }), []);
    assert.deepEqual(evaluateDatabaseCalibration({ manifest: fixed, constraintRows: fixedRows }), []);
    // A constraint present under another name for the same expression also counts as enforced.
    const renamedRows = [...FIXTURE_CONSTRAINTS, { table: 'beta', conname: 'chk_beta_mode_domain', definition: "CHECK (((mode)::text = ANY ((ARRAY['x'::character varying, 'y'::character varying])::text[])))" }];
    assert.deepEqual(evaluateDatabaseCalibration({ manifest: fixed, constraintRows: renamedRows }), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the report groups the worklist by table with absent and enforced counts', () => {
  const { dir, migrations } = fixtureCorpus();
  try {
    const report = renderTableReport(fixtureManifest(migrations));
    assert.match(report, /alpha\s+absent=1\s+enforced=1/);
    assert.match(report, /beta\s+absent=1\s+enforced=0/);
    assert.match(report, /beta_mode_ck/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the committed manifest matches the repository corpus exactly', () => {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(evaluateStaticCensus({ migrationsDir, manifest }), []);
  assert.equal(
    manifest.entries.filter((entry) => !entry.enforced).length,
    manifest.expectedAbsentCount,
  );
});

test('the gate is wired into the unconditional security stage and the DB-backed backend job', () => {
  const security = readFileSync(join(repoRoot, 'scripts', 'ci', 'security.mjs'), 'utf8');
  assert.match(security, /\['--test', 'scripts\/ci\/check-inline-check-census\.test\.mjs'\]/);
  assert.match(security, /\['scripts\/ci\/check-inline-check-census\.mjs'\]/);
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', '_reusable-backend-lint-test.yml'), 'utf8');
  assert.match(workflow, /check-inline-check-census\.mjs --verify-db/);
});
