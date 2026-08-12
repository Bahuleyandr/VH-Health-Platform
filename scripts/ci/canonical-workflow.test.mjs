import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}

test('canonical workflow separates quick pushes from the final full dispatch', () => {
  const workflow = read('.github/workflows/ci.yml');

  assert.match(workflow, /merge_group:\s*\n\s+types: \[checks_requested\]/);
  assert.match(workflow, /workflow_dispatch:\s*\n\s+inputs:\s*\n\s+tier:/);
  assert.match(workflow, /quick_backend:/);
  assert.match(workflow, /lint-and-test:/);
  assert.match(workflow, /fhir-conformance:/);
  assert.match(workflow, /'Full Merge Gate' \|\| 'Merge Gate'/);
  assert.match(workflow, /node scripts\/ci\/assert-canonical-results\.mjs/);
  assert.doesNotMatch(workflow, /run\.mjs --install --changed-on-branch-push/);
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
