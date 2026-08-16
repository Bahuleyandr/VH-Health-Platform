import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertForgejoSupplyChainPins,
  findForgejoSupplyChainViolations,
} from './check-forgejo-supply-chain-pins.mjs';

const actionSha = 'a'.repeat(40);
const imageDigest = 'b'.repeat(64);
const fixtures = [];

function fixture({ workflow, dockerfile }) {
  const root = mkdtempSync(join(tmpdir(), 'vh-forgejo-pins-'));
  fixtures.push(root);
  mkdirSync(join(root, '.forgejo', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'infra', 'forgejo', 'ci-image'), { recursive: true });
  writeFileSync(join(root, '.forgejo', 'workflows', 'ci.yml'), workflow);
  writeFileSync(join(root, 'infra', 'forgejo', 'ci-image', 'Dockerfile'), dockerfile);
  return root;
}

test.afterEach(() => {
  while (fixtures.length > 0) rmSync(fixtures.pop(), { recursive: true, force: true });
});

test('accepts full action commits and digest-pinned workflow/base images', () => {
  const root = fixture({
    workflow: [
      'jobs:',
      '  test:',
      `    uses: https://data.forgejo.org/actions/checkout@${actionSha} # v4`,
      '    services:',
      '      postgres:',
      `        image: pgvector/pgvector:pg18@sha256:${imageDigest}`,
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  assert.deepEqual(findForgejoSupplyChainViolations(root), []);
  assert.doesNotThrow(() => assertForgejoSupplyChainPins(root));
});

test('rejects movable action tags and branch references', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - uses: https://data.forgejo.org/actions/checkout@v4',
      '  - uses: https://github.com/example/action@main',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /full 40-character commit SHA/);
  assert.match(violations[1].message, /full 40-character commit SHA/);
});

test('rejects quoted and expression-driven action references', () => {
  const root = fixture({
    workflow: [
      'steps:',
      "  - uses: 'https://data.forgejo.org/actions/checkout@v4'",
      '  - uses: ${{ matrix.action }}',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /full 40-character commit SHA/);
  assert.match(violations[1].message, /literal HTTPS URL/);
});

test('rejects quoted keys, spaced keys, and flow-map action references', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - "uses": https://example.invalid/action@main',
      '  - uses : https://example.invalid/action@main',
      '  - { name: Unsafe, uses: https://example.invalid/action@main }',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 3);
  assert.ok(violations.every((violation) => /full 40-character/.test(violation.message)));
});

test('rejects YAML-escaped action keys after semantic decoding', () => {
  const root = fixture({
    workflow: '- "u\\u0073es": https://example.invalid/action@main\n',
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /full 40-character commit SHA/);
});

test('rejects explicit and aliased action or image mapping keys', () => {
  const root = fixture({
    workflow: [
      'x-key: &uses-key uses',
      'steps:',
      '  - ? uses',
      '    : https://example.invalid/action@main',
      '  - *uses-key: https://example.invalid/action@main',
      'services:',
      '  db:',
      '    ? image',
      '    : postgres',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 3);
  assert.ok(violations.every((violation) => /direct scalar keys/.test(violation.message)));
});

test('rejects quoted explicit mapping keys before semantic aliasing can hide sinks', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - ? "u\\u0073es"',
      '    : https://example.invalid/action@main',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /direct scalar keys/);
});

test('scans nested workflow directories', () => {
  const root = fixture({
    workflow: `uses: https://data.forgejo.org/actions/checkout@${actionSha}\n`,
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });
  const nestedDir = join(root, '.forgejo', 'workflows', 'nested');
  mkdirSync(nestedDir);
  writeFileSync(
    join(nestedDir, 'unsafe.yml'),
    'uses: https://data.forgejo.org/actions/setup-node@main\n',
  );

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, '.forgejo/workflows/nested/unsafe.yml');
});

test('rejects movable workflow and Forgejo runner images', () => {
  const root = fixture({
    workflow: 'services:\n  postgres:\n    image: pgvector/pgvector:pg18\n',
    dockerfile: 'FROM ghcr.io/example/runner:latest\n',
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /workflow container image/);
  assert.match(violations[1].message, /runner base image/);
});

test('accepts a digest-pinned docker-container BuildKit image', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - run: |',
      '      docker buildx create \\',
      '        --name release-builder \\',
      '        --driver docker-container \\',
      `        --driver-opt "image=moby/buildkit@sha256:${imageDigest}" \\`,
      '        --use',
      `  - run: docker buildx create --name inline-builder --driver=docker-container --driver-opt=image=moby/buildkit@sha256:${imageDigest} --use`,
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  assert.deepEqual(findForgejoSupplyChainViolations(root), []);
});

test('rejects implicit, mutable, and expression-driven BuildKit driver images', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - run: docker buildx create --name implicit-builder --use',
      '  - run: docker buildx create --name mutable-builder --driver docker-container --driver-opt image=moby/buildkit:buildx-stable-1 --use',
      '  - run: |',
      '      docker buildx create \\',
      '        --name expression-builder \\',
      '        --driver=docker-container \\',
      '        --driver-opt "image=${BUILDKIT_IMAGE}" \\',
      '        --use',
      `  - run: docker buildx create --name prefixed-expression --driver docker-container --driver-opt "image=\${BUILDKIT_REPOSITORY}@sha256:${imageDigest}" --use`,
      `  - run: docker buildx create --name decoy-option --driver docker-container --driver-opt "env.BUILDKIT_IMAGE=image=moby/buildkit@sha256:${imageDigest}" --use`,
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 5);
  assert.ok(violations.every((violation) => /BuildKit image/.test(violation.message)));
  assert.match(violations[0].message, /explicit/);
  assert.match(violations[1].message, /sha256 digest/);
  assert.match(violations[2].message, /sha256 digest/);
  assert.match(violations[3].message, /sha256 digest/);
  assert.match(violations[4].message, /explicit/);
});

test('rejects quoted, flow-map, unqualified, and expression-driven images', () => {
  const root = fixture({
    workflow: [
      'services:',
      "  postgres: { 'image': 'postgres' }",
      '  cache:',
      '    "image" : ghcr.io/example/cache:${{ matrix.tag }}',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((violation) => /workflow container image/.test(violation.message)));
});

test('rejects movable tool channels outside action and image references', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - run: npx --yes renovate@latest org/repo',
      '  - uses: https://example.invalid/tunnel@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '    with:',
      '      version: latest',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /tool version must be exact/);
  assert.match(violations[1].message, /npx must execute an exact package version/);
});

test('the repository Forgejo workflows and CI image are immutable', () => {
  assert.doesNotThrow(() => assertForgejoSupplyChainPins(resolve(import.meta.dirname, '..')));
});
