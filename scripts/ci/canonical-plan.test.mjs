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

// PR #949 changed exactly these three files and nothing else. Its first run was
// fully green with `quick_infra: SKIPPED` and `full_infra: SKIPPED`, so
// scripts/backend-image-command-contract.test.mjs — which parses
// apps/backend/Dockerfile into an image model and validates every command in
// infra/kubernetes/apps/backend/*.yaml against it, and runs ONLY inside the
// infra stage — never executed. A broken Dockerfile↔manifest contract could
// have merged green.
test('a Dockerfile-only diff still selects the infra tier that validates it', () => {
  const plan = buildCanonicalPlan({
    eventName: 'push',
    files: [
      'apps/backend/Dockerfile',
      'apps/admin/Dockerfile',
      'apps/staff/Dockerfile.web',
    ],
  });

  assert.equal(plan.tier, 'quick');
  assert.equal(plan.selected.infra, true);
  // The owning stacks keep their gates — infra is added, never substituted.
  assert.equal(plan.selected.backend, true);
  assert.equal(plan.selected.admin, true);
  assert.equal(plan.selected.flutter, true);

  for (const dockerfile of ['apps/backend/Dockerfile', 'apps/admin/Dockerfile', 'apps/staff/Dockerfile.web']) {
    assert.equal(
      buildCanonicalPlan({ eventName: 'push', files: [dockerfile] }).selected.infra,
      true,
      `${dockerfile} alone must still select infra`,
    );
  }
});

test('the backend image contract selects infra for every repo file it resolves', () => {
  // buildImageModel() maps each manifest command back to the repo file the
  // Dockerfile copies into the image, and reads the `npm run` script table to
  // resolve aliases. Deleting or renaming any of these breaks the contract, so
  // each has to reach the stage that checks it.
  for (const file of [
    'apps/backend/package.json',
    'apps/backend/src/cluster.js',
    'apps/backend/scripts/ensure-pgvector-extension.mjs',
    'apps/backend/scripts/ensure-runtime-role-grants.mjs',
  ]) {
    const plan = buildCanonicalPlan({ eventName: 'push', files: [file] });
    assert.equal(plan.selected.infra, true, `${file} must select infra`);
    assert.equal(plan.selected.backend, true, `${file} must keep its backend gate`);
  }
});

test('prose the infra gates assert against selects infra, not security alone', () => {
  // infra-truthfulness.test.mjs pins the MinIO capacity arithmetic to
  // docs/HARDWARE_REQUIREMENTS.md and the backend-Service anchors to
  // apps/device-gateway/README.md; canonical-workflow.test.mjs pins the
  // `[full-ci]` merge-boundary instructions to CLAUDE.md.
  for (const file of [
    'CLAUDE.md',
    'docs/HARDWARE_REQUIREMENTS.md',
    'apps/device-gateway/README.md',
    'infra/forgejo/SUPPLY_CHAIN_PINS.md',
  ]) {
    assert.equal(
      buildCanonicalPlan({ eventName: 'push', files: [file] }).selected.infra,
      true,
      `${file} must select infra`,
    );
  }
});

test('infra input selection only adds a stage, it never narrows a sweep', () => {
  // The infra-input patterns are excluded from the `known` calculation on
  // purpose. A path no stage claims must keep selecting every stage rather
  // than collapsing to an infra-only run because `infra/` now matches.
  for (const file of [
    'infra/continuity-edge/src/verifier.mjs',
    'infra/cloudflare/access/vhhealth-access-policy.json',
  ]) {
    const plan = buildCanonicalPlan({ eventName: 'push', files: [file] });
    assert.deepEqual(
      Object.values(plan.selected),
      [true, true, true, true, true, true, true],
      `${file} must still fan out to every stage`,
    );
  }
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
