import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertWorkflowSupplyChainPins,
  findWorkflowSupplyChainViolations,
} from './check-workflow-supply-chain-pins.mjs';

const actionSha = 'a'.repeat(40);
const imageDigest = 'b'.repeat(64);
const fixtures = [];

function fixture({ workflow }) {
  const root = mkdtempSync(join(tmpdir(), 'vh-workflow-pins-'));
  fixtures.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), workflow);
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
      `    uses: actions/checkout@${actionSha} # v4`,
      '    services:',
      '      postgres:',
      `        image: pgvector/pgvector:pg18@sha256:${imageDigest}`,
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  assert.deepEqual(findWorkflowSupplyChainViolations(root), []);
  assert.doesNotThrow(() => assertWorkflowSupplyChainPins(root));
});

test('rejects movable action tags and branch references', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - uses: actions/checkout@v4',
      '  - uses: example/action@main',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /full 40-character commit SHA/);
  assert.match(violations[1].message, /full 40-character commit SHA/);
});

test('rejects quoted and expression-driven action references', () => {
  const root = fixture({
    workflow: [
      'steps:',
      "  - uses: 'actions/checkout@v4'",
      '  - uses: ${{ matrix.action }}',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /full 40-character commit SHA/);
  assert.match(violations[1].message, /literal GitHub action/);
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

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 3);
  assert.ok(violations.every((violation) => /full 40-character/.test(violation.message)));
});

test('rejects YAML-escaped action keys after semantic decoding', () => {
  const root = fixture({
    workflow: '- "u\\u0073es": https://example.invalid/action@main\n',
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findWorkflowSupplyChainViolations(root);
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

  const violations = findWorkflowSupplyChainViolations(root);
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

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /direct scalar keys/);
});

test('scans nested workflow directories', () => {
  const root = fixture({
    workflow: `uses: actions/checkout@${actionSha}\n`,
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });
  const nestedDir = join(root, '.github', 'workflows', 'nested');
  mkdirSync(nestedDir);
  writeFileSync(
    join(nestedDir, 'unsafe.yml'),
    'uses: actions/setup-node@main\n',
  );

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, '.github/workflows/nested/unsafe.yml');
});

test('rejects movable workflow images', () => {
  const root = fixture({ workflow: 'services:\\n  postgres:\\n    image: pgvector/pgvector:pg18\\n' });
  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0].message, /workflow container image/);
});

test('accepts reviewed Docker commands and Docker words outside command position', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - run: |',
      "      echo 'docker buildx create --driver docker-container is forbidden'",
      "      printf '%s\\n' docker buildx create",
      "      /bin/sh -c 'printf %s docker buildx create'",
      "      /bin/sh \"-c\" 'printf %s docker buildx create'",
      "      /usr/bin/env printf '%s\\n' docker buildx create",
      "      /usr/bin/env \"SAFE=value\" printf '%s\\n' docker buildx create",
      "      /usr/bin/env --argv0 harmless printf '%s\\n' docker buildx create",
      "      /usr/bin/env -S 'printf %s docker buildx create'",
      "      nohup printf '%s\\n' docker buildx create",
      "      nice printf '%s\\n' docker buildx create",
      "      nice -n 5 printf '%s\\n' docker buildx create",
      "      /usr/bin/time -f %E printf '%s\\n' docker buildx create",
      "      s\"h\" -c 'echo docker.io'",
      '      registry=docker.io',
      '      formatter=node',
      '      "$formatter" --version',
      '      printf \'%s\' "$password" | docker login "$registry" -u "$user" --password-stdin',
      '      docker build -t "$image" .',
      '      docker image inspect "$image" --format json',
      '      docker save "$image" -o image.tar',
      '      docker tag "$image" "$target"',
      '      docker push "$target"',
      '      node scripts/run-db-guardrails-docker.mjs',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  assert.deepEqual(findWorkflowSupplyChainViolations(root), []);
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
      '  - run: docker inspect unsafe',
      '  - run: docker container rm unsafe',
      '  - run: docker version',
      '  - run: command docker pull mutable:latest',
      '  - run: time -p docker version',
      '  - run: BUILDX_BUILDER=unsafe docker buildx build .',
      '  - run: docker buildx build --builder unsafe .',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 16);
  assert.ok(violations.every((violation) => /belongs to the digest-pinned setup action/.test(violation.message)));
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

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 8);
  assert.equal(
    violations.filter((violation) => /direct.*scalar/.test(violation.message)).length,
    3,
  );
  assert.equal(
    violations.filter((violation) => /belongs to the digest-pinned setup action/.test(violation.message)).length,
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

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((violation) => /belongs to the digest-pinned setup action/.test(violation.message)));
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
      '  - run: /usr/bin/docker buildx create --driver docker-container',
      '  - run: left=build; right=x; docker "$left$right" create --driver docker-container',
      "  - run: docker $'\\x62\\x75\\x69\\x6c\\x64\\x78' create --driver docker-container",
      '  - run: docker "$(printf build)$(printf x)" create --driver docker-container',
      '  - run: tool=docker; "$tool" buildx create --driver docker-container',
      '  - run: plugin="$(printf docker-buildx)"; "$plugin" create --driver docker-container',
      "  - run: /bin/sh -c 'docker buildx create --driver docker-container'",
      "  - run: /bin/bash -c 'docker buildx create --driver docker-container'",
      '  - run: /usr/bin/env docker buildx create --driver docker-container',
      "  - run: s\"h\" -c 'docker buildx create --driver docker-container'",
      '  - run: nohup docker buildx create --driver docker-container',
      '  - run: nice docker buildx create --driver docker-container',
      "  - run: payload='docker buildx create --driver docker-container'; /bin/sh -c \"$payload\"",
      "  - run: payload='docker buildx create --driver docker-container'; /usr/bin/env sh -c \"$payload\"",
      "  - run: wrapper=/bin/sh; payload='docker buildx create'; \"$wrapper\" -c \"$payload\"",
      "  - run: payload='docker buildx create --driver docker-container'; /bin/sh \"-c\" \"$payload\"",
      '  - run: /usr/bin/env "SAFE=value" docker buildx create --driver docker-container',
      "  - run: /usr/bin/env -S 'docker buildx create --driver docker-container'",
      '  - run: /usr/bin/env --argv0 harmless docker buildx create --driver docker-container',
      '  - run: /usr/bin/time -f %E docker buildx create --driver docker-container',
      '  - run: builder_flag=--builder; docker buildx build "$builder_flag" unsafe .',
      '  - run: options=(--builder unsafe); docker buildx build "${options[@]}" .',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 38);
  assert.ok(violations.every((violation) => /belongs to the digest-pinned setup action/.test(violation.message)));
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

  const violations = findWorkflowSupplyChainViolations(root);
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

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.ok(violations.every((violation) => /workflow container image/.test(violation.message)));
});

test('rejects movable tool channels outside action and image references', () => {
  const root = fixture({
    workflow: [
      'steps:',
      '  - run: npx --yes renovate@latest org/repo',
      '  - uses: example/tunnel@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      '    with:',
      '      version: latest',
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findWorkflowSupplyChainViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0].message, /tool version must be exact/);
  assert.match(violations[1].message, /npx must execute an exact package version/);
});

test('the repository GitHub workflow inputs are immutable', () => {
  assert.doesNotThrow(() => assertWorkflowSupplyChainPins(resolve(import.meta.dirname, '..')));
});


test('BuildKit setup requires an immutable image and docker-container driver', () => {
  const workflow = [
    'steps:',
    `  - uses: docker/setup-buildx-action@${actionSha}`,
    '    with:',
    '      driver: docker-container',
    `      driver-opts: image=moby/buildkit@sha256:${imageDigest}`,
  ].join('\n');
  assert.deepEqual(findWorkflowSupplyChainViolations(fixture({ workflow })), []);
  for (const changed of [
    workflow.replace(`@sha256:${imageDigest}`, ':latest'),
    workflow.replace('      driver: docker-container\n', ''),
    workflow.replace('docker-container', 'remote'),
    workflow.replace('uses:', '"uses":'),
  ]) {
    assert.ok(findWorkflowSupplyChainViolations(fixture({ workflow: changed })).length > 0);
  }
});

test('a missing workflow directory is a failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-workflow-missing-'));
  fixtures.push(root);
  assert.throws(() => assertWorkflowSupplyChainPins(root), /workflow directory is missing/i);
});

test('an empty workflow directory is a failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'vh-workflow-empty-'));
  fixtures.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  assert.throws(() => assertWorkflowSupplyChainPins(root), /no workflow files/i);
});
