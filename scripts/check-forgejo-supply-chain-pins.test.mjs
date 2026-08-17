import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function fixture({
  workflow,
  dockerfile,
  buildkitHelper = `export const BUILDKIT_IMAGE = 'moby/buildkit@sha256:${imageDigest}';\n`,
}) {
  const root = mkdtempSync(join(tmpdir(), 'vh-forgejo-pins-'));
  fixtures.push(root);
  mkdirSync(join(root, '.forgejo', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'infra', 'forgejo', 'ci-image'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'ci'), { recursive: true });
  writeFileSync(join(root, '.forgejo', 'workflows', 'ci.yml'), workflow);
  writeFileSync(join(root, 'infra', 'forgejo', 'ci-image', 'Dockerfile'), dockerfile);
  writeFileSync(join(root, 'scripts', 'ci', 'forgejo-buildkit-builder.mjs'), buildkitHelper);
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

test('rejects a mutable BuildKit helper image', () => {
  const root = fixture({
    workflow: 'steps:\n  - run: echo safe\n',
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
    buildkitHelper: "export const BUILDKIT_IMAGE = 'moby/buildkit:latest';\n",
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /one literal sha256 digest/);
});

test('accepts exact BuildKit helper calls and ordinary build use', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - run: |',
      "      trap 'node scripts/ci/forgejo-buildkit-builder.mjs cleanup release || exit 1' EXIT",
      '      BUILDX_BUILDER="$(node scripts/ci/forgejo-buildkit-builder.mjs prepare release)"',
      '      export BUILDX_BUILDER',
      '      docker buildx build --push .',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  assert.deepEqual(findForgejoSupplyChainViolations(root), []);
});

test('rejects all direct workflow BuildKit lifecycle mutation', () => {
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
      '  - run: docker buildx inspect unsafe --bootstrap',
      '  - run: docker buildx rm unsafe',
      '  - run: docker buildx use unsafe',
      '  - run: docker builder prune --force',
      '  - run: BUILDX_BUILDER=unsafe docker buildx build .',
      '  - run: docker buildx build --builder unsafe .',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 11);
  assert.ok(violations.every((violation) => /delegated to the approved helper/.test(violation.message)));
});

test('rejects folded, continued, quoted, and indirect BuildKit command evasions', () => {
  const root = fixture({
    workflow: [
      'x-build-command: &build-command >-',
      '  docker buildx',
      '  create --name aliased-builder --use',
      'steps:',
      '  - run: >-',
      '      docker buildx',
      '      create --name folded-builder --use',
      '  - run: |',
      '      docker buildx \\',
      '        create --name continued-create --use',
      '  - run: |',
      '      docker \\',
      '        buildx create --name continued-buildx --use',
      '  - run: "\\\"docker\\\" buildx create --name quoted-docker --use"',
      `  - run: \${DOCKER} buildx create --name indirect-docker --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      '  - run: *build-command',
      '  - run: docker buildx',
      '      create --name multiline-plain --use',
      '  - run: >2',
      '      docker buildx create --name explicit-indent --use',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 8);
  assert.equal(
    violations.filter((violation) => /direct.*scalar/.test(violation.message)).length,
    3,
  );
  assert.equal(
    violations.filter((violation) => /delegated to the approved helper/.test(violation.message)).length,
    5,
  );
});

test('does not accept a digest mentioned only in a shell comment or later command', () => {
  const root = fixture({
    workflow: [
      'steps:',
      `  - run: docker buildx create --name commented --use # --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker buildx create --name chained --use && printf '%s' --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((violation) => /delegated to the approved helper/.test(violation.message)));
});

test('rejects non-canonical Buildx argv construction and repeated driver flags', () => {
  const root = fixture({
    workflow: [
      'steps:',
      `  - run: docker buildx create --driver docker --driver docker-container --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker buil"dx" create --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker buildx cre'ate' --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker buil\\dx crea\\te --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker buildx $'create' --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      '  - run: verb=create; docker buildx "$verb" --driver-opt image=moby/buildkit@sha256:${imageDigest}',
      '  - run: docker buildx "$(printf create)" --driver-opt image=moby/buildkit@sha256:${imageDigest}',
      `  - run: "\\\"docker\\\" buildx create --driver-opt image=moby/buildkit@sha256:${imageDigest}"`,
      '  - run: |',
      `      sh -c 'docker buildx create --driver-opt image=moby/buildkit@sha256:${imageDigest}'`,
      `  - run: options='--driver docker'; docker buildx create $options --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker $'buildx' create --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: tool=buildx; docker "$tool" create --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker "$(printf buildx)" create --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker "\${tool:-buildx}" create --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: docker-buildx create --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
      `  - run: /usr/libexec/docker/cli-plugins/docker-buildx create --driver-opt image=moby/buildkit@sha256:${imageDigest}`,
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 16);
  assert.ok(violations.every((violation) => /delegated to the approved helper/.test(violation.message)));
});

test('rejects altered or indirect BuildKit helper calls', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - run: BUILDX_BUILDER="$(node scripts/ci/forgejo-buildkit-builder.mjs prepare "$PROFILE")"',
      '  - run: BUILDX_BUILDER="$(node scripts/ci/forgejo-buildkit-builder.mjs prepare release)" && echo bypass',
      "  - run: trap 'node scripts/ci/forgejo-buildkit-builder.mjs cleanup release' EXIT",
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 3);
  assert.ok(violations.every((violation) => /exact approved command/.test(violation.message)));
});

test('rejects explicit and aliased run mapping keys before command scanning', () => {
  const root = fixture({
    workflow: [
      'x-key: &run-key run',
      'steps:',
      '  - *run-key: docker buildx create --name aliased-key --use',
      '  - ? run',
      '    : docker buildx create --name explicit-key --use',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  const mappingViolations = violations.filter((violation) =>
    /direct scalar keys/.test(violation.message),
  );
  assert.equal(mappingViolations.length, 2);
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

test('repository workflows arm exact cleanup before one-shot builder preparation', () => {
  const workflows = [
    ['deploy-dalekdefender.yml', 'dalek'],
    ['release-images.yml', 'release'],
  ];

  for (const [file, profile] of workflows) {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '..', '.forgejo', 'workflows', file),
      'utf8',
    );
    const trap = workflow.indexOf(
      `trap 'node scripts/ci/forgejo-buildkit-builder.mjs cleanup ${profile} || exit 1' EXIT`,
    );
    const prepare = workflow.indexOf(
      `BUILDX_BUILDER="$(node scripts/ci/forgejo-buildkit-builder.mjs prepare ${profile})"`,
    );
    const firstBuild = workflow.indexOf('docker buildx build');
    assert.ok(trap >= 0, `${file} must arm exact cleanup`);
    assert.ok(prepare > trap, `${file} must arm cleanup before preparation`);
    assert.ok(firstBuild > prepare, `${file} must prepare before building`);
    assert.doesNotMatch(workflow, /docker buildx (?:create|inspect|rm|use)/);
    assert.doesNotMatch(workflow, /rollback_builder|builder_generation|forgejo-buildkit-lifecycle/);
  }

  const releaseWorkflow = readFileSync(
    resolve(import.meta.dirname, '..', '.forgejo', 'workflows', 'release-images.yml'),
    'utf8',
  );
  assert.match(releaseWorkflow, /VH_BUILDKIT_JOB_KEY: \$\{\{ matrix\.app \}\}/);
  assert.match(releaseWorkflow, /concurrency:\s+group: release-images\s/m);
});
