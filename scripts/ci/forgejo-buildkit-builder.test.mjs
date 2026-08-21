import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BUILDKIT_IMAGE,
  buildImages,
  builderPlan,
  cleanupBuilder,
  prepareBuilder,
} from './forgejo-buildkit-builder.mjs';

const expectedImage =
  'moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8';
const validWorkers = JSON.stringify([{
  gcPolicy: [{
    all: true,
    reservedSpace: 8000000000,
    maxUsedSpace: 30000000000,
    minFreeSpace: 300000000000,
  }],
}]);

class FakeDocker {
  constructor({ builders = [], containers = [], stubbornBuilders = [] } = {}) {
    this.builders = new Set(builders);
    this.containers = new Map(
      containers.map((name) => [name, { image: expectedImage, logDriver: 'local' }]),
    );
    this.stubbornBuilders = new Set(stubbornBuilders);
    this.calls = [];
  }

  execute = (args) => {
    this.calls.push([...args]);
    if (args[0] === 'buildx' && args[1] === 'ls') {
      return { status: 0, stdout: [...this.builders].join('\n'), stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      return { status: 0, stdout: [...this.containers.keys()].join('\n'), stderr: '' };
    }
    if (args[0] === 'buildx' && args[1] === 'rm') {
      const name = args.at(-1);
      if (!this.stubbornBuilders.has(name)) {
        this.builders.delete(name);
        for (const container of this.containers.keys()) {
          if (container === `buildx_buildkit_${name}0`) this.containers.delete(container);
        }
      }
      return { status: this.stubbornBuilders.has(name) ? 1 : 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'rm') {
      this.containers.delete(args.at(-1));
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'buildx' && args[1] === 'create') {
      const name = args[args.indexOf('--name') + 1];
      this.builders.add(name);
      this.containers.set(`buildx_buildkit_${name}0`, {
        image: expectedImage,
        logDriver: 'local',
      });
      return { status: 0, stdout: name, stderr: '' };
    }
    if (args[0] === 'buildx' && args[1] === 'inspect') {
      return {
        status: this.builders.has(args[2]) ? 0 : 1,
        stdout: '',
        stderr: '',
      };
    }
    if (args[0] === 'buildx' && args[1] === 'build') {
      return { status: 0, stdout: '', stderr: '' };
    }
    if (args[0] === 'inspect') {
      const container = this.containers.get(args.at(-1));
      if (!container) return { status: 1, stdout: '', stderr: 'not found' };
      if (args[2].includes('Config.Image')) {
        return { status: 0, stdout: container.image, stderr: '' };
      }
      if (args[2].includes('LogConfig.Type')) {
        return { status: 0, stdout: container.logDriver, stderr: '' };
      }
    }
    if (args[0] === 'exec') {
      return { status: 0, stdout: validWorkers, stderr: '' };
    }
    return { status: 99, stdout: '', stderr: `unexpected docker argv: ${args.join(' ')}` };
  };
}

const releaseEnv = {
  GITHUB_RUN_ID: '12345',
  GITHUB_RUN_ATTEMPT: '2',
  VH_BUILDKIT_JOB_KEY: 'backend',
};

test('builder plan derives only bounded workflow-owned names', () => {
  const plan = builderPlan('release', releaseEnv);
  assert.equal(plan.builderName, 'vh-release-builder-backend-run12345-attempt2');
  assert.equal(plan.containerName, 'buildx_buildkit_vh-release-builder-backend-run12345-attempt20');
  assert.equal(plan.ownsBuilder('vh-release-builder-v999'), true);
  assert.equal(plan.ownsBuilder('vh-release-builder-backend-run1-attempt8'), true);
  assert.equal(plan.ownsBuilder('vh-release-builder-admin-run1-attempt8'), false);
  assert.equal(plan.ownsBuilder('unrelated-builder'), false);
});

test('builder plan rejects unreviewed keys and non-numeric runner identity', () => {
  assert.throws(
    () => builderPlan('release', { ...releaseEnv, VH_BUILDKIT_JOB_KEY: '../admin' }),
    /reviewed release matrix entry/,
  );
  assert.throws(
    () => builderPlan('release', { ...releaseEnv, GITHUB_RUN_ID: '123;docker-rm' }),
    /decimal digits/,
  );
});

test('prepare removes a same-name orphan before literal creation and bootstrap', () => {
  const plan = builderPlan('release', releaseEnv);
  const docker = new FakeDocker({ containers: [plan.containerName] });

  prepareBuilder('release', { env: releaseEnv, execute: docker.execute });

  const orphanRemoval = docker.calls.findIndex((args) => args[0] === 'rm');
  const create = docker.calls.findIndex((args) => args[0] === 'buildx' && args[1] === 'create');
  const bootstrap = docker.calls.findIndex(
    (args) => args[0] === 'buildx' && args[1] === 'inspect' && args.includes('--bootstrap'),
  );
  assert.ok(orphanRemoval >= 0 && orphanRemoval < create);
  assert.ok(create < bootstrap);
  assert.deepEqual(docker.calls[create], [
    'buildx',
    'create',
    '--name',
    plan.builderName,
    '--driver',
    'docker-container',
    '--driver-opt',
    `image=${expectedImage}`,
    '--buildkitd-config',
    '.forgejo/buildkitd-dalekdefender.toml',
  ]);
  assert.equal(BUILDKIT_IMAGE, expectedImage);
});

test('prepare retires legacy, higher-generation, and same-key stale state only', () => {
  const plan = builderPlan('release', releaseEnv);
  const otherJob = 'vh-release-builder-admin-run777-attempt1';
  const docker = new FakeDocker({
    builders: [
      'vh-release-builder',
      'vh-release-builder-v1',
      'vh-release-builder-v999',
      'vh-release-builder-backend-run100-attempt1',
      otherJob,
    ],
    containers: [
      'buildx_buildkit_vh-release-builder-v10000',
      'buildx_buildkit_vh-release-builder-backend-run99-attempt10',
      `buildx_buildkit_${otherJob}0`,
    ],
  });

  prepareBuilder('release', { env: releaseEnv, execute: docker.execute });

  assert.deepEqual([...docker.builders].sort(), [otherJob, plan.builderName].sort());
  assert.equal(docker.containers.has(`buildx_buildkit_${otherJob}0`), true);
  assert.equal(
    [...docker.containers.keys()].every(
      (name) => name === `buildx_buildkit_${otherJob}0` || name === plan.containerName,
    ),
    true,
  );
});

test('cleanup removes only the current one-shot builder and backing container', () => {
  const plan = builderPlan('release', releaseEnv);
  const otherJob = 'vh-release-builder-admin-run777-attempt1';
  const docker = new FakeDocker({
    builders: [plan.builderName, otherJob],
    containers: [plan.containerName, `buildx_buildkit_${otherJob}0`],
  });

  cleanupBuilder('release', { env: releaseEnv, execute: docker.execute });

  assert.deepEqual([...docker.builders], [otherJob]);
  assert.deepEqual([...docker.containers.keys()], [`buildx_buildkit_${otherJob}0`]);
});

test('cleanup fails closed when exact stale state survives removal', () => {
  const plan = builderPlan('release', releaseEnv);
  const docker = new FakeDocker({
    builders: [plan.builderName],
    stubbornBuilders: [plan.builderName],
  });

  assert.throws(
    () => cleanupBuilder('release', { env: releaseEnv, execute: docker.execute }),
    /remains after exact-name cleanup/,
  );
});

test('prepare rejects an unexpected live worker policy', () => {
  const docker = new FakeDocker();
  const originalExecute = docker.execute;
  docker.execute = (args) => {
    if (args[0] === 'exec') {
      docker.calls.push([...args]);
      return { status: 0, stdout: JSON.stringify([{ gcPolicy: [] }]), stderr: '' };
    }
    return originalExecute(args);
  };

  assert.throws(
    () => prepareBuilder('release', { env: releaseEnv, execute: docker.execute }),
    /GC policy/,
  );
});

test('release build uses fixed argv and appends the reviewed builder after dynamic inputs', () => {
  const env = {
    ...releaseEnv,
    GITHUB_SHA: 'a'.repeat(40),
    GHCR_IMAGE_OWNER: 'Bahuleyandr',
    IMAGE: 'ghcr.io/bahuleyandr/vh-health-platform-backend',
    PRIMARY_TAG: 'backend-v1.2.3',
    LATEST_TAG: 'latest-backend',
    RELEASE_PLATFORMS: 'linux/amd64,linux/arm64',
  };
  const docker = new FakeDocker();

  buildImages('release', { env, execute: docker.execute });

  const args = docker.calls.at(-1);
  const builderIndex = args.indexOf('--builder');
  assert.equal(args.filter((argument) => argument === '--builder').length, 1);
  assert.equal(args[builderIndex + 1], builderPlan('release', env).builderName);
  assert.ok(builderIndex > args.indexOf('NODE_IMAGE=mirror.gcr.io/library/node:26.5.0-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66'));
  assert.deepEqual(args.slice(-3), ['-f', 'apps/backend/Dockerfile', 'apps/backend']);
});

test('release build keeps dynamic values in fixed argument slots', () => {
  const env = {
    ...releaseEnv,
    VH_BUILDKIT_JOB_KEY: 'admin',
    GITHUB_SHA: 'b'.repeat(40),
    GHCR_IMAGE_OWNER: 'bahuleyandr',
    IMAGE: 'ghcr.io/bahuleyandr/vh-health-platform-adminportal',
    PRIMARY_TAG: 'admin-v1.2.3',
    LATEST_TAG: '',
    RELEASE_PLATFORMS: 'linux/amd64',
    NEXT_PUBLIC_API_URL: '--builder evil',
    SENTRY_AUTH_TOKEN: 'must-not-enter-argv',
  };
  const docker = new FakeDocker();

  buildImages('release', { env, execute: docker.execute });

  const args = docker.calls.at(-1);
  assert.equal(args.filter((argument) => argument === '--builder').length, 1);
  assert.ok(args.includes('NEXT_PUBLIC_API_URL=--builder evil'));
  assert.ok(args.indexOf('--builder') > args.indexOf('NEXT_PUBLIC_API_URL=--builder evil'));
  assert.equal(args.some((argument) => argument.includes('must-not-enter-argv')), false);
  assert.deepEqual(args.slice(-3), ['-f', 'apps/admin/Dockerfile', 'apps/admin']);
});

test('dalek build emits two fixed commands bound to the exact one-shot builder', () => {
  const env = {
    GITHUB_RUN_ID: '456',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'c'.repeat(40),
    GHCR_IMAGE_OWNER: 'bahuleyandr',
    NEXT_PUBLIC_SENTRY_DSN: '',
  };
  const docker = new FakeDocker();

  buildImages('dalek', { env, execute: docker.execute });

  const builds = docker.calls.filter((args) => args[0] === 'buildx' && args[1] === 'build');
  assert.equal(builds.length, 2);
  for (const args of builds) {
    const builderIndex = args.indexOf('--builder');
    assert.equal(args.filter((argument) => argument === '--builder').length, 1);
    assert.equal(args[builderIndex + 1], builderPlan('dalek', env).builderName);
  }
  assert.deepEqual(builds[0].slice(-3), ['-f', 'apps/backend/Dockerfile', 'apps/backend']);
  assert.deepEqual(builds[1].slice(-3), ['-f', 'apps/admin/Dockerfile', 'apps/admin']);
});

test('release build rejects unreviewed target and platform values before Docker', () => {
  const baseEnv = {
    ...releaseEnv,
    GITHUB_SHA: 'd'.repeat(40),
    GHCR_IMAGE_OWNER: 'bahuleyandr',
    IMAGE: 'ghcr.io/bahuleyandr/vh-health-platform-backend',
    PRIMARY_TAG: 'backend-v1.2.3',
    RELEASE_PLATFORMS: 'linux/amd64',
  };
  const docker = new FakeDocker();

  assert.throws(
    () => buildImages('release', {
      env: { ...baseEnv, IMAGE: 'ghcr.io/attacker/foreign' },
      execute: docker.execute,
    }),
    /reviewed release target/,
  );
  assert.throws(
    () => buildImages('release', {
      env: { ...baseEnv, RELEASE_PLATFORMS: 'linux/amd64 --builder unsafe' },
      execute: docker.execute,
    }),
    /unsupported platform/,
  );
  assert.deepEqual(docker.calls, []);
});

test('build failures do not render controlled build values in the command label', () => {
  const secretValue = 'https://sentry.invalid/secret-value';
  const env = {
    ...releaseEnv,
    VH_BUILDKIT_JOB_KEY: 'admin',
    GITHUB_SHA: 'e'.repeat(40),
    GHCR_IMAGE_OWNER: 'bahuleyandr',
    IMAGE: 'ghcr.io/bahuleyandr/vh-health-platform-adminportal',
    PRIMARY_TAG: 'admin-v1.2.3',
    RELEASE_PLATFORMS: 'linux/amd64',
    NEXT_PUBLIC_SENTRY_DSN: secretValue,
  };

  assert.throws(
    () => buildImages('release', {
      env,
      execute: () => ({ status: 1, stdout: '', stderr: 'build failed' }),
    }),
    (error) => /docker buildx build failed/.test(error.message) &&
      !error.message.includes(secretValue),
  );
});
