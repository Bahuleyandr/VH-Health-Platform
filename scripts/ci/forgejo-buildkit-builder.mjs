import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILDKIT_IMAGE =
  'moby/buildkit@sha256:28a898719c18a33f4e8000685287fa36fd0dd9560c6440227d3a732d79bb41d8';
const BUILDKIT_CONFIG = '.forgejo/buildkitd-dalekdefender.toml';
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

function invoke(execute, args, { allowFailure = false } = {}) {
  const result = execute(args);
  if (!result || !Number.isInteger(result.status)) {
    throw new Error(`docker ${args.join(' ')} returned an invalid execution result`);
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `docker ${args.join(' ')} failed (${result.status}): ${result.stderr.trim() || 'no stderr'}`,
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

function main(argv) {
  if (argv.length !== 2 || !['prepare', 'cleanup'].includes(argv[0])) {
    throw new Error(
      'Usage: node scripts/ci/forgejo-buildkit-builder.mjs <prepare|cleanup> <dalek|release>',
    );
  }
  if (argv[0] === 'prepare') console.log(prepareBuilder(argv[1]).builderName);
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
