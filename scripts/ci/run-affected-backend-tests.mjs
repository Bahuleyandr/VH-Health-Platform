#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { changedFilesForBranchPush } from './stage-selection.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const backendRoot = resolve(repoRoot, 'apps/backend');
const jestBin = resolve(backendRoot, 'node_modules/jest/bin/jest.js');
const testPattern = /(^|\/)src\/tests\/.*\.test\.(?:c?js|mjs)$/;
const relatedPattern = /\.(?:c?js|mjs)$/;
export const DEFAULT_MAX_RELATED_TESTS = 64;

const migrationCanaries = [
  'src/tests/unit/audit3MigrationSafety.test.js',
  'src/tests/unit/ciMigrationExecutor.test.js',
  'src/tests/unit/runMigrations.test.js',
  'src/tests/unit/prismaHardening.test.js',
];

const openApiCanaries = [
  'src/tests/unit/openapiBuildSpec.test.js',
  'src/tests/unit/openapiContracts.test.js',
  'src/tests/unit/openapiTagInvariants.test.js',
];

export function selectAffectedBackendInputs(files) {
  const backendFiles = files
    .map((file) => file.replace(/\\/g, '/'))
    .filter((file) => file.startsWith('apps/backend/'));
  const relative = backendFiles.map((file) => file.slice('apps/backend/'.length));
  const changedTests = relative.filter((file) => testPattern.test(file));
  const relatedSources = relative.filter(
    (file) => relatedPattern.test(file) && !testPattern.test(file) && !file.includes('/node_modules/'),
  );
  const mandatoryTests = [];

  if (relative.some((file) => file.startsWith('src/migrations/') || file === 'prisma/schema.prisma')) {
    mandatoryTests.push(...migrationCanaries);
  }
  if (relative.some((file) => file === 'src/app.js' || file.startsWith('src/routes/') || file.includes('openapi'))) {
    mandatoryTests.push(...openApiCanaries);
  }

  return {
    changedTests: [...new Set(changedTests)].sort(),
    relatedSources: [...new Set(relatedSources)].sort(),
    mandatoryTests: [...new Set(mandatoryTests)].sort(),
  };
}

export function selectBoundedAffectedTests({
  changedTests = [],
  mandatoryTests = [],
  relatedTests = [],
  maxRelatedTests = DEFAULT_MAX_RELATED_TESTS,
}) {
  const directTests = new Set([...changedTests, ...mandatoryTests]);
  const uniqueRelatedTests = [...new Set(relatedTests)].sort();
  const relatedIncluded = uniqueRelatedTests.length <= maxRelatedTests;
  const tests = relatedIncluded
    ? new Set([...directTests, ...uniqueRelatedTests])
    : directTests;

  return {
    tests: [...tests].sort(),
    relatedCount: uniqueRelatedTests.length,
    relatedIncluded,
  };
}

function runJest(args, { capture = false } = {}) {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--max-old-space-size=4096',
      jestBin,
      '--runInBand',
      ...args,
    ],
    {
      cwd: backendRoot,
      env: process.env,
      encoding: capture ? 'utf8' : undefined,
      stdio: capture ? 'pipe' : 'inherit',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    if (capture && result.stdout) process.stdout.write(result.stdout);
    if (capture && result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status || 1);
  }
  return result;
}

function discoverRelatedTests(sources) {
  if (sources.length === 0) return [];
  const absoluteSources = sources.map((file) => resolve(backendRoot, file));
  const result = runJest(['--listTests', '--findRelatedTests', ...absoluteSources], { capture: true });
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  if (!existsSync(jestBin)) {
    console.error(`Jest binary not found at ${jestBin}. Run npm ci first.`);
    process.exit(1);
  }

  const changedFiles = changedFilesForBranchPush();
  const selection = selectAffectedBackendInputs(changedFiles);
  const directTests = [];
  for (const file of [...selection.changedTests, ...selection.mandatoryTests]) {
    const absolute = resolve(backendRoot, file);
    if (existsSync(absolute)) directTests.push(absolute);
  }
  const boundedSelection = selectBoundedAffectedTests({
    changedTests: directTests,
    relatedTests: discoverRelatedTests(selection.relatedSources),
  });

  const ordered = boundedSelection.tests;
  console.log(`Related Jest dependency fan-out: ${boundedSelection.relatedCount}`);
  if (!boundedSelection.relatedIncluded) {
    console.log(
      `Dependency fan-out exceeded the quick-gate limit of ${DEFAULT_MAX_RELATED_TESTS}; `
      + 'running every directly changed test and mandatory canary. Full Merge Gate remains exhaustive for this head.',
    );
  }
  console.log(`Affected backend tests: ${ordered.length}`);
  if (ordered.length === 0) {
    console.log('No Jest dependency edge was found; lint, schema, and contract gates remain authoritative for this push.');
    return;
  }

  const chunkSize = 8;
  for (let index = 0; index < ordered.length; index += chunkSize) {
    const chunk = ordered.slice(index, index + chunkSize);
    console.log(`Affected test chunk ${Math.floor(index / chunkSize) + 1}/${Math.ceil(ordered.length / chunkSize)} (${chunk.length} files)`);
    runJest([
      '--forceExit',
      '--testTimeout=60000',
      '--runTestsByPath',
      ...chunk,
    ]);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
