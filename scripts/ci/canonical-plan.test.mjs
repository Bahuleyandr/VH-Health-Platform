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

test('device-gateway changes select the gateway unit gate plus contracts', () => {
  const plan = buildCanonicalPlan({
    eventName: 'push',
    files: ['apps/device-gateway/src/spool.js'],
  });

  assert.equal(plan.tier, 'quick');
  assert.equal(plan.selected.gateway, true);
  assert.equal(plan.selected.contracts, true);
  assert.equal(plan.selected.backend, false);

  const testOnly = buildCanonicalPlan({
    eventName: 'push',
    files: ['apps/device-gateway/tests/legacyDurability.test.js'],
  });
  assert.equal(testOnly.tier, 'quick');
  assert.equal(testOnly.selected.gateway, true);
});

test('CI plumbing changes exercise the full parallel matrix', () => {
  const plan = buildCanonicalPlan({
    eventName: 'push',
    files: ['scripts/ci/run.mjs'],
  });

  assert.equal(plan.tier, 'full');
  assert.deepEqual(Object.values(plan.selected), [true, true, true, true, true, true, true]);
});

test('manual quick dispatch remains available for workflow diagnosis', () => {
  const plan = buildCanonicalPlan({
    eventName: 'workflow_dispatch',
    requestedTier: 'quick',
    files: ['apps/admin/src/example.ts', 'scripts/ci/run.mjs'],
  });

  assert.equal(plan.tier, 'quick');
  assert.equal(plan.selected.admin, true);
  assert.equal(plan.selected.contracts, true);
  assert.equal(plan.selected.backend, true);
});

test('a PR-attached full request forces the exhaustive matrix', () => {
  const plan = buildCanonicalPlan({
    eventName: 'push',
    requestedTier: 'full',
    files: ['apps/backend/src/services/example.js'],
  });

  assert.equal(plan.tier, 'full');
  assert.deepEqual(Object.values(plan.selected), [true, true, true, true, true, true, true]);
});
