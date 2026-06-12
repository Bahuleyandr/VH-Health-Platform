#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const GROUPS = {
  registryUser: {
    label: 'CONTAINER_REGISTRY_USERNAME_or_GHCR_USERNAME',
    anyOf: ['CONTAINER_REGISTRY_USERNAME', 'GHCR_USERNAME'],
  },
  registryPassword: {
    label: 'CONTAINER_REGISTRY_PASSWORD_or_GHCR_TOKEN',
    anyOf: ['CONTAINER_REGISTRY_PASSWORD', 'GHCR_TOKEN'],
  },
};

const MODES = {
  'dalek-images': {
    description: 'Build, push, scan, sign, and verify Dalekdefender backend/admin images',
    required: [
      GROUPS.registryUser,
      GROUPS.registryPassword,
      'COSIGN_PRIVATE_KEY',
      'COSIGN_PASSWORD',
      'COSIGN_PUBLIC_KEY',
    ],
  },
  'dalek-deploy': {
    description: 'Connect to Dalekdefender and pin verified image digests',
    required: [
      GROUPS.registryUser,
      GROUPS.registryPassword,
      'TS_OAUTH_CLIENT_ID',
      'TS_OAUTH_SECRET',
      'DALEKDEFENDER_SSH_KEY',
    ],
  },
  'release-images': {
    description: 'Build, push, SBOM, scan, sign, verify, and publish release images',
    required: [
      GROUPS.registryUser,
      GROUPS.registryPassword,
      'COSIGN_PRIVATE_KEY',
      'COSIGN_PASSWORD',
      'COSIGN_PUBLIC_KEY',
    ],
  },
  'post-deploy-smoke': {
    description: 'Run the hosted API/admin post-deploy smoke gate',
    required: [
      'VH_TRIAL_API_ORIGIN',
      'VH_TRIAL_ADMIN_ORIGIN',
    ],
  },
};

const args = parseArgs(process.argv.slice(2));
const mode = args.mode;
const config = MODES[mode];

if (!config) {
  console.error(`Usage: node scripts/ci/forgejo-deploy-preflight.mjs --mode <${Object.keys(MODES).join('|')}> [--allow-skip] [--summary-file <path>]`);
  process.exit(2);
}

const missing = config.required
  .filter((requirement) => !isSatisfied(requirement))
  .map((requirement) => typeof requirement === 'string' ? requirement : requirement.label);

const allowSkip = args.allowSkip === true;
const summaryFile = args.summaryFile || '';

writeGithubOutput('missing', missing.join(','));
writeGithubOutput('skip', missing.length > 0 && allowSkip ? 'true' : 'false');

if (missing.length === 0) {
  console.log(`Forgejo preflight OK (${mode}): ${config.description}`);
  process.exit(0);
}

const message = `Forgejo preflight missing ${mode} secret(s): ${missing.join(', ')}`;
const annotation = allowSkip ? 'warning' : 'error';
console.error(`::${annotation}::${message}`);
console.error(message);

if (summaryFile) {
  writeSummary(summaryFile, mode, config.description, missing, allowSkip);
}

process.exit(allowSkip ? 0 : 1);

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') parsed.mode = argv[++i];
    else if (arg === '--summary-file') parsed.summaryFile = argv[++i];
    else if (arg === '--allow-skip') parsed.allowSkip = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return parsed;
}

function isSatisfied(requirement) {
  if (typeof requirement === 'string') return hasValue(process.env[requirement]);
  return requirement.anyOf.some((name) => hasValue(process.env[name]));
}

function hasValue(value) {
  return String(value || '').trim().length > 0;
}

function writeGithubOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(outputPath, `${name}=${value}\n`);
}

function writeSummary(filePath, modeName, description, missingNames, skipped) {
  const target = resolve(filePath);
  mkdirSync(dirname(target), { recursive: true });
  const status = skipped ? 'Skipped' : 'Blocked';
  writeFileSync(target, [
    `# Forgejo ${status}: ${modeName}`,
    '',
    description,
    '',
    'Missing repository secret/variable names:',
    '',
    ...missingNames.map((name) => `- \`${name}\``),
    '',
    'No secret values are printed by this preflight.',
    '',
  ].join('\n'));
}
