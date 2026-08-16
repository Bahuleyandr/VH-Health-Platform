import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const bashExecutable = process.platform === 'win32'
  ? 'C:\\Program Files\\Git\\bin\\bash.exe'
  : 'bash';
const lifecycleScript = resolve(
  import.meta.dirname,
  'ci',
  'forgejo-buildkit-lifecycle.sh',
).replaceAll('\\', '/');

function fixture({ workflow, dockerfile }) {
  const root = mkdtempSync(join(tmpdir(), 'vh-forgejo-pins-'));
  fixtures.push(root);
  mkdirSync(join(root, '.forgejo', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'infra', 'forgejo', 'ci-image'), { recursive: true });
  writeFileSync(join(root, '.forgejo', 'workflows', 'ci.yml'), workflow);
  writeFileSync(join(root, 'infra', 'forgejo', 'ci-image', 'Dockerfile'), dockerfile);
  return root;
}

function runLifecycleSnippet(snippet) {
  return spawnSync(
    bashExecutable,
    ['-c', `source "$1"\n${snippet}`, 'bash', lifecycleScript],
    { encoding: 'utf8' },
  );
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
      '  - run: docker buildx create --name cloud-builder --driver=cloud example/acme',
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
    violations.filter((violation) => /BuildKit image/.test(violation.message)).length,
    1,
  );
  assert.equal(
    violations.filter((violation) => /direct.*scalar/.test(violation.message)).length,
    3,
  );
  assert.equal(
    violations.filter((violation) => /canonical literal docker buildx invocation/.test(violation.message)).length,
    4,
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
  assert.ok(violations.every((violation) => /BuildKit image/.test(violation.message)));
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
    ].join('\n'),
    dockerfile: `FROM ghcr.io/example/runner:stable@sha256:${imageDigest}\n`,
  });

  const violations = findForgejoSupplyChainViolations(root);
  assert.equal(violations.length, 10);
  assert.equal(
    violations.filter((violation) => /--driver at most once/.test(violation.message)).length,
    1,
  );
  assert.equal(
    violations.filter((violation) => /canonical literal docker buildx invocation/.test(violation.message)).length,
    8,
  );
  assert.equal(
    violations.filter((violation) => /supported direct argument form/.test(violation.message)).length,
    1,
  );
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

test('repository BuildKit builders verify trust before bootstrap and bound retention', () => {
  const buildkitConfig = readFileSync(
    resolve(import.meta.dirname, '..', '.forgejo', 'buildkitd-dalekdefender.toml'),
  );
  const buildkitConfigSha256 = createHash('sha256').update(buildkitConfig).digest('hex');
  const lifecycleHelper = readFileSync(
    resolve(import.meta.dirname, 'ci', 'forgejo-buildkit-lifecycle.sh'),
    'utf8',
  );
  assert.doesNotMatch(lifecycleHelper, /--bootstrap/);

  const workflows = [
    ['deploy-dalekdefender.yml', 'vh-dalek-builder'],
    ['release-images.yml', 'vh-release-builder'],
  ];

  for (const [file, prefix] of workflows) {
    const workflow = readFileSync(
      resolve(import.meta.dirname, '..', '.forgejo', 'workflows', file),
      'utf8',
    );
    assert.match(workflow, new RegExp(`builder_prefix="${prefix}"`));
    assert.match(workflow, /builder_generation=3/);
    assert.match(workflow, /rollback_builder="\$\{builder_prefix\}-v\$\(\(builder_generation - 1\)\)"/);
    assert.match(workflow, /rollback_builder_image=""/);
    assert.match(workflow, /rollback_builder_config_sha256=""/);

    const bootstrap = workflow.indexOf('docker buildx inspect "$builder_name" --bootstrap');
    const preBootstrapProof = workflow.indexOf('vh_builder_prebootstrap_matches');
    const create = workflow.indexOf('docker buildx create');
    const workerProof = workflow.indexOf('worker_json=');
    const logProof = workflow.indexOf('HostConfig.LogConfig.Type');
    const rollbackDecision = workflow.indexOf('vh_retain_or_retire_rollback');
    const cleanup = workflow.indexOf('vh_retire_builder "$builder_prefix"');
    const firstBuild = workflow.indexOf('docker buildx build', cleanup);
    assert.ok(preBootstrapProof >= 0, `${file} must verify reused state before bootstrap`);
    assert.ok(create > preBootstrapProof, `${file} must branch before literal trusted creation`);
    assert.ok(bootstrap > create, `${file} must bootstrap only after trust or literal creation`);
    assert.ok(workerProof > bootstrap, `${file} must verify a live worker`);
    assert.ok(logProof > workerProof, `${file} must verify the bounded log driver`);
    assert.ok(rollbackDecision > logProof, `${file} rollback decision must follow current health proof`);
    assert.ok(cleanup > rollbackDecision, `${file} stale cleanup must follow rollback decision`);
    assert.ok(firstBuild > cleanup, `${file} cleanup must precede workload builds`);

    const createImage = workflow.match(/--driver-opt "image=([^"]+)"/)?.[1];
    const expectedImage = workflow.match(/expected_builder_image="([^"]+)"/)?.[1];
    assert.equal(expectedImage, createImage, `${file} reused-builder proof must match the create pin`);
    const createConfigSha256 = workflow.match(
      /--driver-opt "env\.VH_BUILDKIT_CONFIG_SHA256=([0-9a-f]{64})"/,
    )?.[1];
    const expectedConfigSha256 = workflow.match(
      /expected_builder_config_sha256="([0-9a-f]{64})"/,
    )?.[1];
    assert.equal(
      expectedConfigSha256,
      buildkitConfigSha256,
      `${file} expected config hash must match the checked-in config`,
    );
    assert.equal(
      createConfigSha256,
      buildkitConfigSha256,
      `${file} creation marker must match the checked-in config`,
    );

    const cleanupBlock = workflow.slice(rollbackDecision, firstBuild);
    const lifecycleBlock = workflow.slice(bootstrap, firstBuild);
    assert.match(cleanupBlock, /while \[ "\$stale_generation" -lt "\$\(\(builder_generation - 1\)\)" \]/);
    assert.match(workflow, /source scripts\/ci\/forgejo-buildkit-lifecycle\.sh/);
    assert.doesNotMatch(lifecycleBlock, /docker\s+(?:builder|buildx|system)\s+prune/);
  }
});

test('builder lifecycle treats first-run current and missing rollback as absent', () => {
  const result = runLifecycleSnippet(`
docker() {
  if [ "$1" = buildx ] && [ "$2" = ls ]; then return 0; fi
  if [ "$1" = container ] && [ "$2" = ls ]; then return 0; fi
  return 91
}
status=0
vh_builder_known vh-release-builder-v3 || status=$?
[ "$status" -eq 1 ]
vh_retain_or_retire_rollback vh-release-builder-v2 buildx_buildkit_vh-release-builder-v20 '' ''
`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /Retiring/);
});

test('builder lifecycle retires an unpinned rollback by exact name', () => {
  const result = runLifecycleSnippet(`
present=true
docker() {
  if [ "$1" = buildx ] && [ "$2" = ls ]; then
    [ "$present" = true ] && printf '%s\\n' vh-release-builder-v2
    return 0
  fi
  if [ "$1" = buildx ] && [ "$2" = inspect ]; then return 0; fi
  if [ "$1" = inspect ]; then printf '%s\\n' moby/buildkit:buildx-stable-1; return 0; fi
  if [ "$1" = buildx ] && [ "$2" = rm ]; then present=false; return 0; fi
  if [ "$1" = container ] && [ "$2" = ls ]; then return 0; fi
  return 92
}
vh_retain_or_retire_rollback vh-release-builder-v2 buildx_buildkit_vh-release-builder-v20 \
  moby/buildkit@sha256:${imageDigest} ${imageDigest}
[ "$present" = false ]
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Retiring unverified rollback builder vh-release-builder-v2/);
});

test('builder lifecycle removes an exact orphan container for an absent rollback', () => {
  const result = runLifecycleSnippet(`
container_present=true
docker() {
  if [ "$1" = buildx ] && [ "$2" = ls ]; then return 0; fi
  if [ "$1" = container ] && [ "$2" = ls ]; then
    [ "$container_present" = true ] && printf '%s\\n' buildx_buildkit_vh-release-builder-v20
    return 0
  fi
  if [ "$1" = rm ]; then container_present=false; return 0; fi
  return 96
}
vh_retain_or_retire_rollback vh-release-builder-v2 buildx_buildkit_vh-release-builder-v20 '' ''
[ "$container_present" = false ]
`);
  assert.equal(result.status, 0, result.stderr);
});

test('builder lifecycle does not treat enumeration failure as absence', () => {
  const result = runLifecycleSnippet(`
docker() {
  if [ "$1" = buildx ] && [ "$2" = ls ]; then return 7; fi
  return 97
}
if vh_retain_or_retire_rollback vh-release-builder-v2 buildx_buildkit_vh-release-builder-v20 '' ''; then
  exit 98
fi
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Unable to enumerate Buildx builders/);
});

test('builder lifecycle fails closed when corrupt stale state remains', () => {
  const result = runLifecycleSnippet(`
docker() {
  if [ "$1" = buildx ] && [ "$2" = ls ]; then printf '%s\\n' vh-release-builder-v2; return 0; fi
  if [ "$1" = buildx ] && [ "$2" = inspect ]; then return 7; fi
  if [ "$1" = buildx ] && [ "$2" = rm ]; then return 8; fi
  return 93
}
if vh_retain_or_retire_rollback vh-release-builder-v2 buildx_buildkit_vh-release-builder-v20 \
  moby/buildkit@sha256:${imageDigest} ${imageDigest}; then
  exit 94
fi
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /remains after exact-name cleanup/);
});

test('builder lifecycle retains a future rollback only after pre-bootstrap proof', () => {
  const result = runLifecycleSnippet(`
rm_called=false
docker() {
  if [ "$1" = buildx ] && [ "$2" = ls ]; then printf '%s\\n' vh-release-builder-v3; return 0; fi
  if [ "$1" = buildx ] && [ "$2" = inspect ]; then return 0; fi
  if [ "$1" = inspect ] && [[ "$3" == *Config.Image* ]]; then
    printf '%s\\n' moby/buildkit@sha256:${imageDigest}; return 0
  fi
  if [ "$1" = inspect ] && [[ "$3" == *Config.Env* ]]; then
    printf '%s\\n' VH_BUILDKIT_CONFIG_SHA256=${imageDigest}; return 0
  fi
  if [ "$1" = inspect ] && [[ "$3" == *LogConfig.Type* ]]; then printf '%s\\n' local; return 0; fi
  if [ "$1" = buildx ] && [ "$2" = rm ]; then rm_called=true; return 0; fi
  return 95
}
vh_retain_or_retire_rollback vh-release-builder-v3 buildx_buildkit_vh-release-builder-v30 \
  moby/buildkit@sha256:${imageDigest} ${imageDigest}
[ "$rm_called" = false ]
`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Retaining verified rollback builder vh-release-builder-v3/);
});
