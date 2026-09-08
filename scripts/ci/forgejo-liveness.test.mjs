import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_MAX_RUN_AGE_HOURS,
  SCHEDULED_WORKFLOW,
  STATE,
  applyAcknowledgements,
  deriveScheduledStages,
  evaluateLiveness,
  renderReport,
} from './forgejo-liveness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..', '..');
const fixtureDir = path.join(here, 'fixtures', 'forgejo-liveness');
const detector = path.join(here, 'forgejo-liveness.mjs');

const fixture = (name) => JSON.parse(readFileSync(path.join(fixtureDir, `${name}.json`), 'utf8'));
const failed = (r) => r.checks.filter((c) => !c.ok);
const states = (r) => [...new Set(failed(r).map((c) => c.state))].sort();

/*
 * POSITIVE CONTROLS FIRST.
 *
 * This detector exists to break a silence, so every state it can report has a
 * fixture that must produce it. A detector only ever observed returning "ok"
 * has not been shown capable of returning anything else. The healthy fixture
 * is the matching negative control: without it, a detector hard-wired to fail
 * would also pass every test below.
 */

test('healthy mirror passes every check (negative control)', () => {
  const result = evaluateLiveness(fixture('healthy'));
  assert.equal(result.ok, true, renderReport(result));
  assert.equal(failed(result).length, 0);
  // 1 drift + 1 parity + one per monitored stage.
  assert.equal(result.checks.length, 2 + fixture('healthy').monitoredStages.length);
});

// ---------------------------------------------------------------- UNREACHABLE

test('a failed collection reports MIRROR UNREACHABLE and names the failing step', () => {
  const result = evaluateLiveness(fixture('unreachable-collection'));
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.UNREACHABLE]);
  const c = result.checks[0];
  assert.match(c.detail, /failing step: forgejo API over the tailnet/);
  assert.match(c.detail, /timeout/);
  assert.match(c.action, /tailnet/);
  // Short-circuits: never emit drift or parity verdicts from data we do not have.
  assert.equal(result.checks.length, 1);
});

test('an empty ref listing is UNREACHABLE, never a branch diff', () => {
  // For ~90 seconds on 2026-09-08 two reviewers read an empty probe result as
  // "the mirror has lost every branch". A real parity break never drops main.
  for (const name of ['unreachable-empty-refs', 'unreachable-refs-without-main']) {
    const result = evaluateLiveness(fixture(name));
    assert.equal(result.ok, false, name);
    assert.deepEqual(states(result), [STATE.UNREACHABLE], name);
    assert.equal(result.checks.length, 1, name);
    const detail = result.checks[0].detail;
    assert.match(detail, /failed probe, not an empty set/, name);
    // The decisive assertion: main must never be reported as one-sided.
    assert.ok(!/one-sided/i.test(detail), name);
    assert.ok(!/github-only: main|forgejo-only: main/.test(detail), name);
  }
});

// ----------------------------------------------------------- DIVERGED/BEHIND

test('drift between github/main and origin/main reports DIVERGED / BEHIND', () => {
  const result = evaluateLiveness(fixture('drifted'));
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.DRIFT]);
  const c = failed(result)[0];
  assert.match(c.detail, /ahead_by=534/);
  assert.match(c.action, /git push origin github\/main:main/);
});

test('an unreadable main SHA is STALE, not a silent pass', () => {
  const result = evaluateLiveness(fixture('unreadable-main-sha'));
  assert.equal(result.ok, false);
  assert.ok(states(result).includes(STATE.STALE));
});

// --------------------------------------------------------------- ONE-SIDED

test('a github-only branch is named with its direction', () => {
  const result = evaluateLiveness(fixture('one-sided-github'));
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.ONE_SIDED]);
  const c = failed(result)[0];
  assert.match(c.detail, /github-only: fix\/forgejo-ci-image-liveness/);
  assert.ok(!/forgejo-only:/.test(c.detail));
});

test('a forgejo-only branch is named with its direction', () => {
  // The recurring one: GitHub's merge-time branch delete does not touch the
  // mirror, so the leftover is always forgejo-only.
  const result = evaluateLiveness(fixture('one-sided-forgejo'));
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.ONE_SIDED]);
  const c = failed(result)[0];
  assert.match(c.detail, /forgejo-only: feat\/cath-readiness-pr1-790/);
  assert.ok(!/github-only:/.test(c.detail));
});

test('both directions are reported together, not just the first found', () => {
  const result = evaluateLiveness(fixture('one-sided-both'));
  assert.equal(result.ok, false);
  const c = failed(result)[0];
  assert.match(c.detail, /github-only: fix\/inf-006-release-authority/);
  assert.match(c.detail, /forgejo-only: feat\/cath-readiness-pr1-790/);
  assert.match(c.action, /Prune or push/);
});

// ------------------------------------------------- JOBS / STALE (population)

test('failing scheduled stages report SCHEDULED JOBS NOT COMPLETING for every stage', () => {
  // The real 2026-08-17..2026-09-08 outage: the whole ubuntu-latest population.
  const fx = fixture('runs-failing');
  const result = evaluateLiveness(fx);
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.JOBS]);
  assert.equal(failed(result).length, fx.monitoredStages.length);
  for (const stage of fx.monitoredStages) {
    assert.ok(
      failed(result).some((c) => c.id === `scheduled-run:${stage}`),
      `stage ${stage} is not covered`,
    );
  }
  assert.match(failed(result)[0].action, /rebuild vhhealth\/act-java17/);
});

test('a schedule that stopped firing is STALE even though the runs were green', () => {
  const result = evaluateLiveness(fixture('stale'));
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.STALE]);
  assert.match(failed(result)[0].detail, /stopped firing/);
});

test('missing scheduled runs fail rather than vacuously passing', () => {
  const result = evaluateLiveness(fixture('missing-scheduled-runs'));
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.STALE]);
  assert.equal(failed(result).length, fixture('missing-scheduled-runs').monitoredStages.length);
});

test('an empty monitored population is a failure, not a green sweep', () => {
  const result = evaluateLiveness(fixture('empty-population'));
  assert.equal(result.ok, false);
  assert.ok(states(result).includes(STATE.STALE));
  assert.match(failed(result)[0].detail, /EMPTY/);
});

test('push-event tasks with the same stage names are not mistaken for the schedule', () => {
  const healthy = fixture('healthy');
  const decoys = healthy.tasks.filter((t) => t.event === 'push');
  assert.ok(decoys.length >= 2, 'fixture must contain push-event decoys');
  assert.ok(decoys.every((t) => t.status === 'failure'), 'decoys must be failing or this proves nothing');
  assert.equal(evaluateLiveness(healthy).ok, true);
});

test('the age budget is enforced at its boundary', () => {
  const base = fixture('healthy');
  const now = new Date(base.now).getTime();
  const withAge = (h) => ({
    ...base,
    tasks: base.tasks.map((t) =>
      t.workflow_id === SCHEDULED_WORKFLOW && t.event === 'schedule'
        ? { ...t, updated_at: new Date(now - h * 3600 * 1000).toISOString() }
        : t,
    ),
  });
  assert.equal(evaluateLiveness(withAge(DEFAULT_MAX_RUN_AGE_HOURS - 1)).ok, true);
  assert.equal(evaluateLiveness(withAge(DEFAULT_MAX_RUN_AGE_HOURS + 1)).ok, false);
});

test('an unusable "now" throws instead of silently comparing against NaN', () => {
  assert.throws(() => evaluateLiveness({ ...fixture('healthy'), now: 'nope' }), /unusable "now"/);
});

// ------------------------------------------------- monitored population shape

test('the monitored population is derived from the real workflow and is not empty', () => {
  // PREDICATE: every entry of matrix.stage on the `runs-on: ubuntu-latest` job
  // in .forgejo/workflows/full-stack-sweep.yml, the mirror's only scheduled
  // workflow. Derived, not hard-coded, so a new stage is covered automatically.
  const wf = readFileSync(
    path.join(repoRoot, '.forgejo', 'workflows', 'full-stack-sweep.yml'), 'utf8',
  );
  const stages = deriveScheduledStages(wf);
  assert.ok(stages.length > 0, 'empty population would make the sweep vacuous');
  assert.deepEqual([...stages].sort(), ['admin', 'backend', 'fhir', 'flutter', 'infra', 'security']);
  // It really is the ubuntu-latest population that is being watched.
  assert.match(wf, /runs-on:\s*ubuntu-latest/);
});

test('deriving stages from a workflow with no stage list is a hard error', () => {
  // Positive control for the derivation: it must be able to refuse.
  assert.throws(
    () => deriveScheduledStages('jobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: []\n'),
    /EMPTY stage population/,
  );
  assert.throws(
    () => deriveScheduledStages('jobs:\n  x:\n    runs-on: docker-builder\n'),
    /no longer has a `runs-on: ubuntu-latest` job/,
  );
});

// ------------------------------------------------------------- workflow shape

/**
 * Extract the shell script of every `run:` step.
 *
 * Deliberately NOT a regex over the whole file. The first attempt at the
 * pipefail guard scanned raw step text for /pipefail/ and was satisfied by the
 * explanatory COMMENT above the step, so deleting the real `set -o pipefail`
 * left it green. Only the script body counts, so only the body is returned.
 */
function extractRunScripts(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const scripts = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)run:\s*(\S.*)?$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const inline = m[2];
    if (inline && !/^[|>][-+]?\d*$/.test(inline.trim())) {
      scripts.push(inline);
      continue;
    }
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') { body.push(''); continue; }
      if (line.length - line.trimStart().length <= indent) break;
      body.push(line.trim());
    }
    scripts.push(body.join('\n'));
  }
  return scripts;
}

const workflowPath = path.join(repoRoot, '.github', 'workflows', 'forgejo-mirror-liveness.yml');
const isPiped = (s) => s.split('\n').some((l) => /\S\s*\|\s*\S/.test(l) && !/\|\|/.test(l));

test('the run-script extractor sees what it claims to see', () => {
  const sample = [
    'jobs:', '  a:', '    steps:',
    '      # set -o pipefail is mentioned only in this comment',
    '      - name: piped without pipefail',
    '        run: |',
    '          node thing.mjs | tee out.txt',
    '      - name: inline',
    '        run: echo hello',
  ].join('\n');
  assert.deepEqual(extractRunScripts(sample), ['node thing.mjs | tee out.txt', 'echo hello']);
});

test('the pipefail guard rejects a workflow that pipes without pipefail', () => {
  const bad = ['jobs:', '  a:', '    steps:', '      - name: bad', '        run: |',
    '          node scripts/ci/forgejo-liveness.mjs | tee out.txt'].join('\n');
  const piped = extractRunScripts(bad).filter(isPiped);
  assert.equal(piped.length, 1);
  assert.doesNotMatch(piped[0], /pipefail/);
});

test('every piped run step in the liveness workflow sets pipefail', () => {
  const scripts = extractRunScripts(readFileSync(workflowPath, 'utf8'));
  assert.ok(scripts.length > 0, 'no run: steps found - the scan itself is broken');
  const piped = scripts.filter(isPiped);
  assert.ok(piped.length > 0, 'no piped step found - this guard would pass vacuously');
  for (const s of piped) {
    assert.match(
      s, /^\s*set -[a-zA-Z]*o[a-zA-Z]*\s+pipefail|^\s*set -o pipefail/m,
      `a run: step pipes without pipefail, so a failing command reports green:\n${s.slice(0, 300)}`,
    );
  }
});

test('the live job never runs on push, and the self-test always does', () => {
  // The live job is RED until the owner rebuilds the runner image. Left on
  // push it would paint every PR head red and train reviewers to ignore it.
  // The self-test must stay on push: it is the positive control for changes
  // to the detector itself.
  const yaml = readFileSync(workflowPath, 'utf8');
  const liveJob = yaml.slice(yaml.indexOf('  mirror-liveness:'), yaml.indexOf('    steps:', yaml.indexOf('  mirror-liveness:')));
  assert.match(liveJob, /if:\s*>?-?\s*[\s\S]*github\.event_name == 'schedule'/);
  assert.match(liveJob, /github\.event_name == 'workflow_dispatch'/);
  const selfTest = yaml.slice(yaml.indexOf('  detector-selftest:'), yaml.indexOf('  mirror-liveness:'));
  assert.ok(!/^\s{4}if:/m.test(selfTest), 'the self-test must not be gated off any event');
});

test('the liveness workflow runs at least hourly', () => {
  // Branch-set parity breaks per merge, not slowly. A daily cadence would let
  // a post-merge lapse sit for a day.
  const yaml = readFileSync(workflowPath, 'utf8');
  const crons = [...yaml.matchAll(/cron:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(crons.length > 0, 'no schedule found');
  assert.ok(
    crons.some((c) => /^(\S+)\s+\*(\/1)?\s/.test(c)),
    `expected an hourly cron, found ${JSON.stringify(crons)}`,
  );
});

test('the liveness workflow does not name a required status check', () => {
  // Branch protection on main requires exactly "Merge Gate" and "Full Merge
  // Gate". This workflow is an alarm, not a gate.
  const yaml = readFileSync(workflowPath, 'utf8');
  const names = [...yaml.matchAll(/^\s{4}name:\s*(.+)$/gm)].map((m) => m[1].trim());
  assert.ok(names.length >= 2, `expected job names, found ${JSON.stringify(names)}`);
  for (const ctx of ['Merge Gate', 'Full Merge Gate']) {
    assert.ok(!names.includes(ctx), `job name "${ctx}" is a required status check on main`);
  }
});

// -------------------------------------------------------------- exit codes

function runDetector(name) {
  const env = { ...process.env, LIVENESS_FIXTURE: path.join(fixtureDir, `${name}.json`) };
  delete env.GITHUB_STEP_SUMMARY;
  try {
    return { code: 0, out: execFileSync(process.execPath, [detector], { env, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('CLI exits 0 only on the healthy fixture, non-zero on every other', () => {
  // The workflow gates on the exit code, not the returned object, so the exit
  // code needs its own positive control.
  const healthy = runDetector('healthy');
  assert.equal(healthy.code, 0, healthy.out);
  assert.match(healthy.out, /Forgejo mirror liveness: OK/);

  // `acknowledged` is a WAIVED failure, so it exits 0 by design; every other
  // fixture must exit non-zero.
  const acknowledged = runDetector('acknowledged');
  assert.equal(acknowledged.code, 0, acknowledged.out);
  assert.match(acknowledged.out, /ACKNOWLEDGED defect\(s\) - not healthy, waived/, acknowledged.out);

  const broken = readdirSync(fixtureDir)
    .map((f) => f.replace(/\.json$/, ''))
    .filter((n) => n !== 'healthy' && n !== 'acknowledged');
  assert.ok(broken.length >= 11, `expected the full state matrix, found ${broken.length}`);
  for (const name of broken) {
    const r = runDetector(name);
    assert.equal(r.code, 1, `${name} should exit non-zero:\n${r.out}`);
    assert.match(r.out, /FAILING|MIRROR UNREACHABLE/, `${name} should say it is failing`);
  }
});

test('the LIVE collection path runs and degrades to MIRROR UNREACHABLE', () => {
  /*
   * Every other test drives the pure evaluator through LIVENESS_FIXTURE, so
   * none of them execute collectSnapshot, the workflow read, or the CLI's
   * non-fixture branch. That gap already hid a real bug: the collection
   * branch called `require()` inside an ES module, which would have thrown
   * ReferenceError on the first scheduled run while the whole fixture suite
   * stayed green.
   *
   * Pointed at an unroutable address, so it is offline, fast and
   * deterministic - it proves the code path executes and reports the right
   * state, not that the network works.
   */
  const env = {
    ...process.env,
    FORGEJO_API: 'http://127.0.0.1:1/api/v1',
    GITHUB_API_URL: 'http://127.0.0.1:1',
    FORGEJO_TIMEOUT_MS: '1500',
    SCHEDULED_WORKFLOW_PATH: path.join(
      repoRoot, '.forgejo', 'workflows', 'full-stack-sweep.yml',
    ),
  };
  delete env.LIVENESS_FIXTURE;
  delete env.GITHUB_STEP_SUMMARY;
  let out;
  let code = 0;
  try {
    out = execFileSync(process.execPath, [detector], { env, encoding: 'utf8' });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  assert.equal(code, 1, `live path should fail closed, got:\n${out}`);
  assert.match(out, /MIRROR UNREACHABLE/, out);
  assert.match(out, /failing step:/, out);
  // The specific regression: an ESM/CJS mistake surfaces here, not as a state.
  assert.ok(!/ReferenceError|is not defined/.test(out), `live path crashed:\n${out}`);
});

// ------------------------------------------------- ACKNOWLEDGED defect state

/*
 * Three positive controls, exactly as required: an acknowledged failure is
 * still REPORTED; a DIFFERENT failure is not suppressed; and the waiver STOPS
 * at its expiry. The expiry tests drive an INJECTED clock, not the wall clock
 * - an expiry checked only against Date.now() would be documentation, because
 * the assertion would not change behaviour until the date really passed.
 */

const ACK = [{
  state: STATE.JOBS,
  match: 'scheduled-run:',
  reason: 'Runner image missing; owner rebuild pending.',
  until: '2026-10-08T00:00:00Z',
}];
const BEFORE = new Date('2026-09-08T12:00:00Z').getTime();
const AFTER = new Date('2026-10-09T00:00:00Z').getTime();

test('(a) an acknowledged failure is still reported, not hidden', () => {
  const result = evaluateLiveness(fixture('acknowledged'));
  assert.equal(result.ok, true, 'a waived defect should not hold the alarm red');
  const waived = result.checks.filter((c) => c.acknowledged);
  assert.equal(waived.length, fixture('acknowledged').monitoredStages.length);
  for (const c of waived) {
    assert.equal(c.state, STATE.ACKNOWLEDGED);
    assert.equal(c.suppressedState, STATE.JOBS);
    // Still visible, with the reason and the expiry attached.
    assert.match(c.detail, /finished "failure"/);
    assert.match(c.detail, /ACKNOWLEDGED until 2026-10-08/);
    assert.match(c.detail, /rebuild pending/);
  }
  // And the summary line refuses to call it healthy.
  assert.match(renderReport(result), /OK with 6 ACKNOWLEDGED defect\(s\) - not healthy, waived/);
});

test('(b) an acknowledgement does not suppress a DIFFERENT failure', () => {
  // Same waiver, but the mirror has also drifted. Drift must stay hard-red.
  const snapshot = {
    ...fixture('acknowledged'),
    forgejoMainSha: 'a4ffe98601b1b2c3d4e5f60718293a4b5c6d7e8f',
    compare: { status: 'ahead', ahead_by: 534, behind_by: 0 },
  };
  const result = evaluateLiveness(snapshot);
  assert.equal(result.ok, false, 'drift must not be waived by a JOBS acknowledgement');
  assert.deepEqual(states(result), [STATE.DRIFT]);
  // The jobs are still waived - the waiver is narrow, not global.
  assert.ok(result.checks.some((c) => c.acknowledged));
});

test('(b2) a waiver matches only its own state and id, never by accident', () => {
  /*
   * The third entry is the one that matters, and it is the reason this test
   * exists in this shape. A mutation dropping the `state` check survived an
   * earlier version, because every non-waived id there also failed the id
   * match - the test passed for the wrong reason. `scheduled-run:flutter`
   * below matches the waiver's id substring EXACTLY but carries a different
   * state, so only the state comparison can save it.
   *
   * The property is real, not academic: the waiver says "these stages fail
   * because the runner image is missing". If the mirror's scheduler stops
   * altogether the same stages go STALE, and that is a new fault which must
   * not inherit this waiver.
   */
  const checks = [
    { id: 'scheduled-run:backend', state: STATE.JOBS, ok: false, detail: 'd', action: '' },
    { id: 'branch-parity', state: STATE.ONE_SIDED, ok: false, detail: 'd', action: '' },
    { id: 'mirror-drift', state: STATE.DRIFT, ok: false, detail: 'd', action: '' },
    { id: 'scheduled-run:flutter', state: STATE.STALE, ok: false, detail: 'd', action: '' },
  ];
  const out = applyAcknowledgements(checks, ACK, BEFORE);
  assert.equal(out[0].state, STATE.ACKNOWLEDGED);
  assert.equal(out[1].state, STATE.ONE_SIDED, 'parity must not be waived');
  assert.equal(out[2].state, STATE.DRIFT, 'drift must not be waived');
  assert.equal(
    out[3].state, STATE.STALE,
    'a matching id with a DIFFERENT state must not be waived',
  );
  assert.equal(out.filter((c) => c.ok).length, 1);
});

test('(c) the waiver stops at its expiry, proved with an injected clock', () => {
  const failing = [
    { id: 'scheduled-run:backend', state: STATE.JOBS, ok: false, detail: 'd', action: '' },
  ];
  const before = applyAcknowledgements(failing, ACK, BEFORE);
  assert.equal(before[0].ok, true);
  assert.equal(before[0].state, STATE.ACKNOWLEDGED);

  const after = applyAcknowledgements(failing, ACK, AFTER);
  assert.equal(after[0].ok, false, 'an expired waiver must stop suppressing');
  assert.equal(after[0].state, STATE.JOBS);
  assert.ok(!after[0].acknowledged);
});

test('(c2) end-to-end: the same fixture flips to FAILING once the clock passes until', () => {
  const fx = fixture('acknowledged');
  assert.equal(evaluateLiveness(fx).ok, true);
  assert.ok(evaluateLiveness(fx).checks.some((c) => c.acknowledged));

  const result = evaluateLiveness({ ...fx, now: '2026-10-09T00:00:00Z' });
  assert.equal(result.ok, false, 'the waiver must not outlive its expiry');
  // Nothing is waived any more - that is the property under test.
  assert.ok(!result.checks.some((c) => c.acknowledged), 'expired waiver still suppressing');
  // At that clock the fixture's tasks are also a month old, so the stage
  // checks land on STALE rather than JOBS. Either way they are hard failures;
  // asserting the exact state here would be asserting the fixture's age, not
  // the expiry behaviour.
  assert.ok(states(result).every((s) => s !== STATE.ACKNOWLEDGED));
});

test('a fixture run never picks up the committed production waiver list', () => {
  /*
   * Config bleed is a false green with extra steps. This assertion caught a
   * real one: the CLI read the committed acknowledgement file even when a
   * fixture was supplied, so `runs-failing` - a fixture with no waivers of its
   * own - exited 0 because the production waiver happened to match it.
   */
  const committed = JSON.parse(
    readFileSync(path.join(here, 'forgejo-liveness-acknowledged.json'), 'utf8'),
  );
  assert.ok(
    committed.entries.some((e) => e.state === STATE.JOBS),
    'this test is vacuous unless the committed list would actually match runs-failing',
  );
  const r = runDetector('runs-failing');
  assert.equal(r.code, 1, `fixture must be judged on its own contents:\n${r.out}`);
  assert.ok(!/ACKNOWLEDGED/.test(r.out), `production waiver leaked into a fixture run:\n${r.out}`);
});

test('a malformed or over-broad acknowledgement fails closed', () => {
  const failing = [
    { id: 'scheduled-run:backend', state: STATE.JOBS, ok: false, detail: 'd', action: '' },
  ];
  const cases = [
    [[{ state: STATE.JOBS, match: 'x', reason: 'r' }], /missing a non-empty "until"/],
    [[{ state: STATE.JOBS, match: 'x', reason: '', until: '2030-01-01' }], /missing a non-empty "reason"/],
    [[{ state: STATE.JOBS, match: 'x', reason: 'r', until: 'soon' }], /unparseable "until"/],
    [[{ state: STATE.UNREACHABLE, match: '', reason: 'r', until: '2030-01-01' }], /missing a non-empty "match"/],
    [[{ state: STATE.UNREACHABLE, match: 'x', reason: 'r', until: '2030-01-01' }], /never waivable/],
  ];
  for (const [bad, re] of cases) {
    assert.throws(() => applyAcknowledgements(failing, bad, BEFORE), re);
  }
});

test('MIRROR UNREACHABLE can never be waived, even by a matching entry', () => {
  // It is produced by a short-circuit that returns before acknowledgements are
  // applied, so "I could not see the mirror" is structurally unwaivable.
  const result = evaluateLiveness({
    ...fixture('unreachable-collection'),
    acknowledgements: [{ state: STATE.JOBS, match: '', reason: 'r', until: '2030-01-01' }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(states(result), [STATE.UNREACHABLE]);
});

test('the committed acknowledgement list is well-formed and time-boxed', () => {
  const list = JSON.parse(
    readFileSync(path.join(here, 'forgejo-liveness-acknowledged.json'), 'utf8'),
  );
  assert.ok(Array.isArray(list.entries), 'entries must be an array');
  // Running the committed list through the real validator is the point: a
  // malformed list must fail here, not silently do nothing in production.
  applyAcknowledgements([], list.entries, Date.now());
  for (const e of list.entries) {
    assert.ok(new Date(e.until).getTime() > 0, `entry "${e.match}" needs a real expiry`);
    assert.ok(e.reason.length > 40, `entry "${e.match}" needs a real written reason`);
  }
});

test('every alarm state has a fixture that produces it', () => {
  // Guards the reverse rot: a state added without a fixture that fires it.
  const produced = new Set();
  for (const f of readdirSync(fixtureDir)) {
    const r = evaluateLiveness(fixture(f.replace(/\.json$/, '')));
    for (const c of r.checks) produced.add(c.state);
  }
  for (const state of Object.values(STATE)) {
    assert.ok(produced.has(state), `no fixture ever produces state "${state}"`);
  }
});
