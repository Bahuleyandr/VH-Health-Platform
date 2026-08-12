import assert from 'node:assert/strict';
import test from 'node:test';

import { buildCanonicalPlan } from './canonical-plan.mjs';

test('ordinary backend pushes select the quick backend gate only', () => {
  const plan = buildCanonicalPlan({
    eventName: 'push',
    files: ['apps/backend/src/services/example.js'],
  });

  assert.equal(plan.tier, 'quick');
  assert.equal(plan.selected.backend, true);
  assert.equal(plan.selected.admin, false);
  assert.equal(plan.selected.flutter, false);
});

test('client changes add contracts while retaining their owning stack', () => {
  const plan = buildCanonicalPlan({
    eventName: 'push',
    files: ['apps/staff/lib/core/services/example.dart'],
  });

  assert.equal(plan.tier, 'quick');
  assert.equal(plan.selected.flutter, true);
  assert.equal(plan.selected.contracts, true);
});

test('CI plumbing changes exercise the full parallel matrix', () => {
  const plan = buildCanonicalPlan({
    eventName: 'push',
    files: ['scripts/ci/run.mjs'],
  });

  assert.equal(plan.tier, 'full');
  assert.deepEqual(Object.values(plan.selected), [true, true, true, true, true, true]);
});

test('merge queue commits always receive the full gate', () => {
  const plan = buildCanonicalPlan({
    eventName: 'merge_group',
    files: ['docs/README.md'],
  });

  assert.equal(plan.tier, 'full');
  assert.deepEqual(Object.values(plan.selected), [true, true, true, true, true, true]);
});

test('manual quick dispatch remains available for workflow diagnosis', () => {
  const plan = buildCanonicalPlan({
    eventName: 'workflow_dispatch',
    requestedTier: 'quick',
    files: ['apps/admin/src/example.ts'],
  });

  assert.equal(plan.tier, 'quick');
  assert.equal(plan.selected.admin, true);
  assert.equal(plan.selected.contracts, true);
});
