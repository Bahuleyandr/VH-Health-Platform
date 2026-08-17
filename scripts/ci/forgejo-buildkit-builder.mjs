import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILDKIT_IMAGE =
  'moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8';
const BUILDKIT_CONFIG = '.forgejo/buildkitd-dalekdefender.toml';
const NODE_IMAGE =
  'mirror.gcr.io/library/node:26.5.0-alpine@sha256:e88a35be04478413b7c71c455cd9865de9b9360e1f43456be5951032d7ac1a66';
const expectedGcPolicy = {
  reservedSpace: 8000000000,
  maxUsedSpace: 30000000000,
  minFreeSpace: 300000000000,
};
const releaseJobKeys = new Set(['admin', 'backend', 'staff-web']);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function requiredDigits(env, name) {
  const value = env[name];
  if (!/^\d+$/.test(value || '')) {
    throw new Error(`${name} must contain only decimal digits`);
  }
  return value;
}

export function builderPlan(profile, env = process.env) {
  if (!['dalek', 'release'].includes(profile)) {
    throw new Error(`Unsupported BuildKit profile: ${profile}`);
  }

  const runId = requiredDigits(env, 'GITHUB_RUN_ID');
  const runAttempt = requiredDigits(env, 'GITHUB_RUN_ATTEMPT');
  const base = profile === 'dalek' ? 'vh-dalek-builder' : 'vh-release-builder';
  const jobKey = profile === 'dalek' ? null : env.VH_BUILDKIT_JOB_KEY;
  if (profile === 'release' && !releaseJobKeys.has(jobKey)) {
    throw new Error('VH_BUILDKIT_JOB_KEY must identify a reviewed release matrix entry');
  }

  const activePrefix = jobKey ? `${base}-${jobKey}` : base;
  const builderName = `${activePrefix}-run${runId}-attempt${runAttempt}`;
  const containerName = `buildx_buildkit_${builderName}0`;
  const legacyPattern = `${escapeRegex(base)}(?:-v\\d+)?`;
  const oneShotPattern = `${escapeRegex(activePrefix)}-run\\d+-attempt\\d+`;
  const ownedBuilderPattern = new RegExp(`^(?:${legacyPattern}|${oneShotPattern})$`);
  const ownedContainerPattern = new RegExp(
    `^buildx_buildkit_(?:${legacyPattern}|${oneShotPattern})\\d+$`,
  );
  const currentContainerPattern = new RegExp(
    `^buildx_buildkit_${escapeRegex(builderName)}\\d+$`,
  );

  return {
    builderName,
    containerName,
    ownsBuilder: (name) => ownedBuilderPattern.test(name),
    ownsContainer: (name) => ownedContainerPattern.test(name),
    isCurrentContainer: (name) => currentContainerPattern.test(name),
  };
}

function executeDocker(args) {
  const result = spawnSync('docker', args, {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    encoding: 'utf8',
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || result.error?.message || '',
  };
}

function invoke(execute, args, { allowFailure = false, display } = {}) {
  const result = execute(args);
  const command = display || `docker ${args.join(' ')}`;
  if (!result || !Number.isInteger(result.status)) {
    throw new Error(`${command} returned an invalid execution result`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `${command} failed (${result.status}): ${result.stderr.trim() || 'no stderr'}`,
    );
  }
  return result;
}

function listedNames(execute, args, label) {
  const output = invoke(execute, args).stdout.trim();
  const names = output ? output.split(/\r?\n/) : [];
  if (names.some((name) => !name || name.trim() !== name)) {
    throw new Error(`Unable to parse exact ${label} names`);
  }
  return names;
}

function listBuilders(execute) {
  return listedNames(execute, ['buildx', 'ls', '--format', '{{.Name}}'], 'Buildx builder');
}

function listContainers(execute) {
  return listedNames(
    execute,
    ['container', 'ls', '--all', '--format', '{{.Names}}'],
    'Docker container',
  );
}

function retireMatching(plan, execute, { currentOnly }) {
  const ownsBuilder = currentOnly
    ? (name) => name === plan.builderName
    : plan.ownsBuilder;
  const ownsContainer = currentOnly
    ? plan.isCurrentContainer
    : plan.ownsContainer;

  for (const name of listBuilders(execute).filter(ownsBuilder)) {
    invoke(execute, ['buildx', 'rm', '--force', name], { allowFailure: true });
  }
  const remainingBuilders = listBuilders(execute).filter(ownsBuilder);
  if (remainingBuilders.length > 0) {
    throw new Error(
      `BuildKit builder remains after exact-name cleanup: ${remainingBuilders.join(', ')}`,
    );
  }

  for (const name of listContainers(execute).filter(ownsContainer)) {
    invoke(execute, ['rm', '--force', name], { allowFailure: true });
  }
  const remainingContainers = listContainers(execute).filter(ownsContainer);
  if (remainingContainers.length > 0) {
    throw new Error(
      `BuildKit container remains after exact-name cleanup: ${remainingContainers.join(', ')}`,
    );
  }
}

function verifyWorkerPolicy(rawWorkers) {
  let workers;
  try {
    workers = JSON.parse(rawWorkers);
  } catch {
    throw new Error('Pinned BuildKit worker inventory is not valid JSON');
  }
  const valid = Array.isArray(workers) && workers.length > 0 && workers.every(
    (worker) => Array.isArray(worker.gcPolicy) && worker.gcPolicy.some(
      (policy) => policy.all === true &&
        policy.reservedSpace === expectedGcPolicy.reservedSpace &&
        policy.maxUsedSpace === expectedGcPolicy.maxUsedSpace &&
        policy.minFreeSpace === expectedGcPolicy.minFreeSpace,
    ),
  );
  if (!valid) throw new Error('Pinned BuildKit GC policy does not match the Dalekdefender cap');
}

export function prepareBuilder(
  profile,
  { env = process.env, execute = executeDocker } = {},
) {
  const plan = builderPlan(profile, env);
  retireMatching(plan, execute, { currentOnly: false });

  invoke(execute, [
    'buildx',
    'create',
    '--name',
    plan.builderName,
    '--driver',
    'docker-container',
    '--driver-opt',
    `image=${BUILDKIT_IMAGE}`,
    '--buildkitd-config',
    BUILDKIT_CONFIG,
  ]);
  invoke(execute, ['buildx', 'inspect', plan.builderName, '--bootstrap']);

  const actualImage = invoke(
    execute,
    ['inspect', '--format', '{{.Config.Image}}', plan.containerName],
  ).stdout.trim();
  if (actualImage !== BUILDKIT_IMAGE) {
    throw new Error('BuildKit builder image does not match the reviewed digest');
  }

  const logDriver = invoke(
    execute,
    ['inspect', '--format', '{{.HostConfig.LogConfig.Type}}', plan.containerName],
  ).stdout.trim();
  if (logDriver !== 'local') {
    throw new Error('Pinned BuildKit builder is not using the bounded local log driver');
  }

  const workerJson = invoke(
    execute,
    ['exec', plan.containerName, 'buildctl', 'debug', 'workers', '--format', '{{json .}}'],
  ).stdout;
  verifyWorkerPolicy(workerJson);
  return plan;
}

export function cleanupBuilder(
  profile,
  { env = process.env, execute = executeDocker } = {},
) {
  const plan = builderPlan(profile, env);
  retireMatching(plan, execute, { currentOnly: true });
}

function normalizedOwner(env) {
  const owner = (env.GHCR_IMAGE_OWNER || 'bahuleyandr').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(owner)) {
    throw new Error('GHCR_IMAGE_OWNER is not a valid reviewed package owner');
  }
  return owner;
}

function requiredCommit(env) {
  const commit = env.GITHUB_SHA || '';
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error('GITHUB_SHA must be a full commit SHA');
  return commit;
}

function requiredTag(value, label) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(value || '')) {
    throw new Error(`${label} is not a valid container tag`);
  }
  return value;
}

function releasePlatforms(env, jobKey) {
  if (jobKey === 'staff-web') return 'linux/amd64';
  const platforms = env.RELEASE_PLATFORMS || 'linux/amd64';
  if (!/^linux\/(?:amd64|arm64)(?:,linux\/(?:amd64|arm64))*$/.test(platforms)) {
    throw new Error('RELEASE_PLATFORMS contains an unsupported platform');
  }
  return platforms;
}

function addOption(args, option, value) {
  args.push(option, value);
}

function invokeBuild(execute, plan, spec) {
  const args = [
    'buildx',
    'build',
    '--pull',
    '--platform',
    spec.platforms,
    '--metadata-file',
    spec.metadataFile,
    '--push',
  ];
  for (const tag of spec.tags) addOption(args, '-t', tag);
  for (const context of spec.buildContexts || []) addOption(args, '--build-context', context);
  for (const buildArg of spec.buildArgs || []) addOption(args, '--build-arg', buildArg);
  for (const secret of spec.secrets || []) addOption(args, '--secret', secret);
  args.push('--builder', plan.builderName, '-f', spec.dockerfile, spec.context);
  invoke(execute, args, { display: 'docker buildx build' });
}

function dalekBuilds(plan, env, execute) {
  const owner = normalizedOwner(env);
  const commit = requiredCommit(env);
  const tag = `dalek-${commit}`;
  invokeBuild(execute, plan, {
    platforms: 'linux/amd64',
    metadataFile: 'output/dalekdefender/backend-metadata.json',
    tags: [`ghcr.io/${owner}/vh-health-platform-backend:${tag}`],
    buildArgs: [`NODE_IMAGE=${NODE_IMAGE}`],
    dockerfile: 'apps/backend/Dockerfile',
    context: 'apps/backend',
  });
  invokeBuild(execute, plan, {
    platforms: 'linux/amd64',
    metadataFile: 'output/dalekdefender/admin-metadata.json',
    tags: [`ghcr.io/${owner}/vh-health-platform-adminportal:${tag}`],
    buildContexts: ['backend=apps/backend'],
    buildArgs: [
      'NEXT_PUBLIC_API_URL=https://dalekdefender.hippocampus-monitor.ts.net:8444',
      'NEXT_PUBLIC_APP_NAME=VH Health Admin',
      'NEXT_PUBLIC_ALLOWED_ORIGIN=https://dalekdefender.hippocampus-monitor.ts.net',
      `NEXT_PUBLIC_SENTRY_DSN=${env.NEXT_PUBLIC_SENTRY_DSN || ''}`,
      'NEXT_PUBLIC_SENTRY_ENVIRONMENT=dalekdefender',
      `NEXT_PUBLIC_SENTRY_RELEASE=${commit}`,
      'NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=0.1',
      'NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE=0',
      'NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE=0',
      'SENTRY_UPLOAD_SOURCE_MAPS=false',
    ],
    dockerfile: 'apps/admin/Dockerfile',
    context: 'apps/admin',
  });
}

function releaseBuild(plan, env, execute) {
  const jobKey = env.VH_BUILDKIT_JOB_KEY;
  const owner = normalizedOwner(env);
  const commit = requiredCommit(env);
  const app = {
    backend: {
      imageName: 'vh-health-platform-backend',
      dockerfile: 'apps/backend/Dockerfile',
      context: 'apps/backend',
      buildArgs: [`NODE_IMAGE=${NODE_IMAGE}`],
    },
    admin: {
      imageName: 'vh-health-platform-adminportal',
      dockerfile: 'apps/admin/Dockerfile',
      context: 'apps/admin',
      buildContexts: ['backend=apps/backend'],
      buildArgs: [
        `NEXT_PUBLIC_API_URL=${env.NEXT_PUBLIC_API_URL || 'https://api.vhhealth.app'}`,
        `NEXT_PUBLIC_APP_NAME=${env.NEXT_PUBLIC_APP_NAME || 'VH Health Admin'}`,
        `NEXT_PUBLIC_ALLOWED_ORIGIN=${env.NEXT_PUBLIC_ALLOWED_ORIGIN || 'https://admin.vhhealth.app'}`,
        `NEXT_PUBLIC_SENTRY_DSN=${env.NEXT_PUBLIC_SENTRY_DSN || ''}`,
        `NEXT_PUBLIC_SENTRY_ENVIRONMENT=${env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || 'production'}`,
        `NEXT_PUBLIC_SENTRY_RELEASE=${commit}`,
        `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE=${env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || '0.1'}`,
        `NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE=${env.NEXT_PUBLIC_SENTRY_REPLAY_SESSION_SAMPLE_RATE || '0'}`,
        `NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE=${env.NEXT_PUBLIC_SENTRY_REPLAY_ERROR_SAMPLE_RATE || '0'}`,
        'SENTRY_UPLOAD_SOURCE_MAPS=false',
      ],
      secrets: env.SENTRY_AUTH_TOKEN ? ['id=sentry_auth_token,env=SENTRY_AUTH_TOKEN'] : [],
    },
    'staff-web': {
      imageName: 'vhhealth-staff-web',
      dockerfile: 'apps/staff/Dockerfile.web',
      context: '.',
      buildArgs: [
        `VH_BASE_URL=${env.STAFF_WEB_API_URL || 'https://api.vhhealth.app/api/v1'}`,
        `VH_API_KEY=${env.STAFF_WEB_API_KEY || ''}`,
        `APP_NAME=${env.STAFF_WEB_APP_NAME || 'VH Health Staff'}`,
        `SENTRY_DSN=${env.SENTRY_DSN_STAFF || ''}`,
        `SENTRY_ENVIRONMENT=${env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || 'production'}`,
        `SENTRY_RELEASE=${commit}`,
      ],
    },
  }[jobKey];
  const image = `ghcr.io/${owner}/${app.imageName}`;
  if (env.IMAGE !== image) throw new Error('IMAGE does not match the reviewed release target');
  const tags = [`${image}:${requiredTag(env.PRIMARY_TAG, 'PRIMARY_TAG')}`];
  if (env.LATEST_TAG) tags.push(`${image}:${requiredTag(env.LATEST_TAG, 'LATEST_TAG')}`);
  invokeBuild(execute, plan, {
    platforms: releasePlatforms(env, jobKey),
    metadataFile: `output/release-images/${jobKey}/build-metadata.json`,
    tags,
    buildContexts: app.buildContexts,
    buildArgs: app.buildArgs,
    secrets: app.secrets,
    dockerfile: app.dockerfile,
    context: app.context,
  });
}

export function buildImages(
  profile,
  { env = process.env, execute = executeDocker } = {},
) {
  const plan = builderPlan(profile, env);
  if (profile === 'dalek') dalekBuilds(plan, env, execute);
  else releaseBuild(plan, env, execute);
}

function main(argv) {
  if (argv.length !== 2 || !['prepare', 'build', 'cleanup'].includes(argv[0])) {
    throw new Error(
      'Usage: node scripts/ci/forgejo-buildkit-builder.mjs <prepare|build|cleanup> <dalek|release>',
    );
  }
  if (argv[0] === 'prepare') console.log(prepareBuilder(argv[1]).builderName);
  else if (argv[0] === 'build') buildImages(argv[1]);
  else cleanupBuilder(argv[1]);
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
