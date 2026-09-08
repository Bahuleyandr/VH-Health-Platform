import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_RUN_AGE_HOURS,
  REQUIRED_SCHEDULED_JOBS,
  SCHEDULED_WORKFLOW,
  evaluateLiveness,
  renderReport,
} from './forgejo-liveness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'forgejo-liveness');
const detector = path.join(here, 'forgejo-liveness.mjs');

function fixture(name) {
  return JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8'));
}

function failedIds(result) {
  return result.checks.filter((c) => !c.ok).map((c) => c.id).sort();
}

/*
 * POSITIVE CONTROL FIRST.
 *
 * The whole point of this detector is to break a silence. A detector that has
 * only ever been seen returning "ok" has not been shown to be capable of
 * returning anything else, so every assertion below is paired: one fixture
 * where the check must PASS, and at least one where the same check must FAIL.
 * If someone later guts evaluateLiveness into `return {ok: true}`, the
 * must-fail cases go red immediately.
 */

test('healthy mirror passes every check (negative control)', () => {
  const result = evaluateLiveness(fixture('healthy'));
  assert.equal(result.ok, true, renderReport(result));
  assert.deepEqual(failedIds(result), []);
  assert.equal(result.checks.length, 1 + REQUIRED_SCHEDULED_JOBS.length);
});

test('drift between github/main and origin/main fails loudly', () => {
  const result = evaluateLiveness(fixture('drifted'));
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ['mirror-drift']);
  const drift = result.checks.find((c) => c.id === 'mirror-drift');
  assert.match(drift.detail, /DRIFT/);
  // The compare shape must reach the operator: "behind by N" and "diverged"
  // have different fixes.
  assert.match(drift.detail, /ahead_by=534/);
  assert.match(drift.detail, /git push origin github\/main:main/);
});

test('failed scheduled backend and admin runs fail loudly', () => {
  // This fixture is the real 2026-08-17..2026-09-08 outage: every
  // runs-on: ubuntu-latest job died in ~2s at container setup.
  const result = evaluateLiveness(fixture('runs-failing'));
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ['scheduled-run:admin', 'scheduled-run:backend']);
  for (const c of result.checks.filter((x) => !x.ok)) {
    assert.match(c.detail, /finished "failure"/);
  }
});

test('a schedule that stopped firing fails even though the runs were green', () => {
  const result = evaluateLiveness(fixture('stale'));
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ['scheduled-run:admin', 'scheduled-run:backend']);
  for (const c of result.checks.filter((x) => !x.ok)) {
    assert.match(c.detail, /STALE/);
  }
});

test('missing scheduled runs fail rather than vacuously passing', () => {
  // An empty candidate set must NOT read as success. This is the classic
  // empty-population green: a verdict over nothing reporting "fine".
  const result = evaluateLiveness(fixture('missing-scheduled-runs'));
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ['scheduled-run:admin', 'scheduled-run:backend']);
  for (const c of result.checks.filter((x) => !x.ok)) {
    assert.match(c.detail, /No scheduled/);
  }
});

test('an unreadable mirror is a failure, not a skip', () => {
  const result = evaluateLiveness(fixture('unreadable-mirror'));
  assert.equal(result.ok, false);
  assert.deepEqual(failedIds(result), ['mirror-drift']);
  assert.match(
    result.checks.find((c) => c.id === 'mirror-drift').detail,
    /unreadable/,
  );
});

test('push-event tasks with the same job names are not mistaken for the schedule', () => {
  // ci.yml also has jobs literally named "backend" and "admin". If the filter
  // ignored workflow_id/event, the healthy fixture's failing push tasks would
  // flip the verdict and the detector would alarm on every merge.
  const healthy = fixture('healthy');
  const pushNoise = healthy.tasks.filter((t) => t.event === 'push');
  assert.ok(pushNoise.length >= 2, 'fixture must contain push-event decoys');
  assert.ok(
    pushNoise.every((t) => t.status === 'failure'),
    'the decoys must be failing, or this test proves nothing',
  );
  assert.equal(evaluateLiveness(healthy).ok, true);
});

test('the age budget is enforced at its boundary', () => {
  const base = fixture('healthy');
  const now = new Date(base.now).getTime();
  const withAge = (hours) => ({
    ...base,
    tasks: base.tasks.map((t) =>
      t.workflow_id === SCHEDULED_WORKFLOW && t.event === 'schedule'
        ? { ...t, updated_at: new Date(now - hours * 3600 * 1000).toISOString() }
        : t,
    ),
  });
  assert.equal(evaluateLiveness(withAge(DEFAULT_MAX_RUN_AGE_HOURS - 1)).ok, true);
  assert.equal(evaluateLiveness(withAge(DEFAULT_MAX_RUN_AGE_HOURS + 1)).ok, false);
});

test('an unusable "now" throws instead of silently comparing against NaN', () => {
  assert.throws(
    () => evaluateLiveness({ ...fixture('healthy'), now: 'not-a-date' }),
    /unusable "now"/,
  );
});

/*
 * END-TO-END EXIT CODES.
 *
 * The workflow gates on the process exit code, not on the returned object, so
 * the exit code itself needs a positive control.
 */

function runDetector(fixtureName) {
  const env = {
    ...process.env,
    LIVENESS_FIXTURE: path.join(fixtureDir, `${fixtureName}.json`),
  };
  delete env.GITHUB_STEP_SUMMARY;
  try {
    const stdout = execFileSync(process.execPath, [detector], {
      env,
      encoding: 'utf8',
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('CLI exits 0 on a healthy mirror and non-zero on every broken one', () => {
  const healthy = runDetector('healthy');
  assert.equal(healthy.code, 0, healthy.stdout);
  assert.match(healthy.stdout, /Forgejo mirror liveness: OK/);

  for (const broken of [
    'drifted',
    'runs-failing',
    'stale',
    'missing-scheduled-runs',
    'unreadable-mirror',
  ]) {
    const result = runDetector(broken);
    assert.equal(result.code, 1, `${broken} should exit non-zero:\n${result.stdout}`);
    assert.match(result.stdout, /FAILING/, `${broken} should say it is failing`);
  }
});

test('every shipped fixture is exercised by this suite', () => {
  // Guards the reverse rot: a fixture added without a matching assertion.
  const shipped = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const names = [
    'healthy',
    'drifted',
    'runs-failing',
    'stale',
    'missing-scheduled-runs',
    'unreadable-mirror',
  ];
  const onDisk = execFileSync(
    process.execPath,
    ['-e', `process.stdout.write(require('node:fs').readdirSync(${JSON.stringify(fixtureDir)}).join(','))`],
    { encoding: 'utf8' },
  )
    .split(',')
    .filter(Boolean)
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
  assert.deepEqual(onDisk, [...names].sort());
  for (const n of names) {
    assert.ok(shipped.includes(`'${n}'`), `fixture ${n} is never asserted on`);
  }
});
