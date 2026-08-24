import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

function jobBlock(workflow, jobId) {
  const header = `  ${jobId}:`;
  const start = workflow.indexOf(header);
  assert.notEqual(start, -1, `job ${jobId} not found`);

  const nextJob = /^  [A-Za-z0-9_-]+:\r?$/gm;
  nextJob.lastIndex = start + header.length;
  const next = nextJob.exec(workflow);
  return workflow.slice(start, next?.index ?? workflow.length);
}

test('canonical workflow separates quick pushes from the final full marker', () => {
  const workflow = read('.github/workflows/ci.yml');

  // Merge queues are unavailable for this user-owned repository (workflow
  // header); an inert merge_group trigger must not reappear and imply
  // otherwise.
  assert.doesNotMatch(workflow, /merge_group:/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tier:/);
  assert.match(workflow, /quick_backend:/);
  assert.match(workflow, /lint-and-test:/);
  assert.match(workflow, /fhir-conformance:/);
  assert.match(workflow, /contains\(github\.event\.head_commit\.message, '\[full-ci\]'\)/);
  assert.match(workflow, /needs\.plan\.outputs\.tier == 'full' && 'Full Merge Gate' \|\| 'Merge Gate'/);
  assert.match(workflow, /needs\.plan\.outputs\.tier == 'full' && 'Merge Gate' \|\| 'Full run Merge Gate not requested'/);
  assert.match(workflow, /FULL_MERGE_GATE_RESULT: \$\{\{ needs\.merge_gate\.result \}\}/);
  assert.match(workflow, /node scripts\/ci\/assert-canonical-results\.mjs/);
  assert.doesNotMatch(workflow, /run\.mjs --install --changed-on-branch-push/);
});

test('[full-ci] runs one exhaustive matrix and publishes both required contexts', () => {
  const workflow = read('.github/workflows/ci.yml');
  const quickJobs = [
    'quick_backend',
    'quick_fhir',
    'quick_admin',
    'quick_flutter',
    'quick_contracts',
    'quick_gateway',
    'quick_infra',
  ];
  const fullJobs = [
    'lint-and-test',
    'fhir-conformance',
    'full_admin',
    'full_flutter',
    'full_contracts',
    'full_gateway',
    'full_infra',
  ];

  assert.equal(
    (workflow.match(/contains\(github\.event\.head_commit\.message, '\[full-ci\]'\)/g) || []).length,
    1,
  );
  for (const jobId of quickJobs) {
    assert.match(jobBlock(workflow, jobId), /needs\.plan\.outputs\.tier == 'quick'/);
  }
  for (const jobId of fullJobs) {
    assert.match(jobBlock(workflow, jobId), /needs\.plan\.outputs\.tier == 'full'/);
  }

  assert.match(
    jobBlock(workflow, 'merge_gate'),
    /name: \$\{\{ needs\.plan\.outputs\.tier == 'full' && 'Full Merge Gate' \|\| 'Merge Gate' \}\}/,
  );
  assert.match(
    jobBlock(workflow, 'full_merge_gate_compat'),
    /name: \$\{\{ needs\.plan\.outputs\.tier == 'full' && 'Merge Gate' \|\| 'Full run Merge Gate not requested' \}\}/,
  );
});

test('operator docs require a no-source-change [full-ci] marker instead of a final dispatch', () => {
  const instructions = read('CLAUDE.md');

  assert.match(instructions, /git commit --allow-empty -m "ci: run final canonical gate \[full-ci\]"/);
  assert.match(instructions, /manual dispatch is\s+not the pull-request merge boundary/);
  assert.doesNotMatch(instructions, /gh workflow run ci\.yml --ref <branch> -f tier=full/);
});

test('backend full gate generates Prisma once before parallel consumers', () => {
  const workflow = read('.github/workflows/_reusable-backend-lint-test.yml');

  assert.match(workflow, /prepare-prisma:/);
  assert.match(workflow, /static-checks:\s*\r?\n\s+name: Backend lint \+ static checks\s*\r?\n\s+needs: prepare-prisma/);
  assert.match(workflow, /test:\s*\r?\n\s+name: Backend tests .*\r?\n\s+needs: prepare-prisma/);
  assert.equal((workflow.match(/name: Restore generated Prisma client/g) || []).length, 3);
});

test('backend quick gate saves a generated Prisma client before affected tests', () => {
  const workflow = read('.github/workflows/_reusable-backend-quick.yml');
  const verifyIndex = workflow.indexOf('name: Verify generated Prisma client');
  const saveIndex = workflow.indexOf('name: Save generated Prisma client');
  const testsIndex = workflow.indexOf('name: Run affected backend tests');

  assert.match(workflow, /uses: actions\/cache\/restore@caa296126883cff596d87d8935842f9db880ef25/);
  assert.match(workflow, /uses: actions\/cache\/save@caa296126883cff596d87d8935842f9db880ef25/);
  assert.ok(verifyIndex >= 0 && verifyIndex < saveIndex);
  assert.ok(saveIndex < testsIndex);
});

test('both backend tiers run the migration-number collision guard', () => {
  // The guard shipped invocable only from apps/backend's local `npm run ci`
  // chain, which no workflow calls, so a duplicate migration number could not
  // fail a merge gate. Both tiers must carry it: the quick tier is what an
  // ordinary feature push (where a migration actually lands) selects, and the
  // full tier is the `[full-ci]` merge boundary.
  for (const file of ['_reusable-backend-quick.yml', '_reusable-backend-lint-test.yml']) {
    assert.match(read(`.github/workflows/${file}`), /run: npm run check:migration-numbers/);
  }

  // The npm script must exist, and stay the single definition the local `ci`
  // chain uses too.
  const pkg = JSON.parse(read('apps/backend/package.json'));
  assert.equal(
    pkg.scripts['check:migration-numbers'],
    'node scripts/check-migration-number-collisions.mjs',
  );
  assert.match(pkg.scripts.ci, /npm run check:migration-numbers/);
});

test('long standalone stack workflows are manual and smoke is nightly', () => {
  for (const file of ['ci-admin.yml', 'ci-flutter.yml', 'ci-client-contract.yml', 'ci-kubernetes.yml']) {
    const workflow = read(`.github/workflows/${file}`);
    assert.match(workflow, /on:\s*\n\s+workflow_dispatch:/);
    assert.doesNotMatch(workflow, /\n\s+pull_request:/);
    assert.doesNotMatch(workflow, /\n\s+push:/);
  }

  const smoke = read('.github/workflows/smoke-e2e.yml');
  assert.match(smoke, /schedule:\s*\n\s+- cron: '15 2 \* \* \*'/);
  assert.doesNotMatch(smoke, /\n\s+pull_request:/);
});

test('backend PR wrapper retains only CodeQL on automatic events', () => {
  const workflow = read('.github/workflows/ci-backend.yml');

  assert.match(workflow, /lint-and-test:\s*\n\s+if: .*workflow_dispatch/);
  assert.match(workflow, /fhir-conformance:\s*\n\s+if: .*workflow_dispatch/);
  assert.match(workflow, /semgrep:\s*\n\s+if: .*workflow_dispatch/);
  assert.match(workflow, /codeql:/);
});
