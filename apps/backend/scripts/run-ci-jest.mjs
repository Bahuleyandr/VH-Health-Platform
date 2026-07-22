#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseShardSpec, chunkBelongsToShard } from './lib/jestShard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const jestBin = path.join(backendRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const chunkSize = Number(process.env.JEST_CI_CHUNK_SIZE || 8);
const oldSpaceMb = Number(process.env.JEST_OLD_SPACE_MB || 4096);
const testTimeoutMs = Number(process.env.JEST_TEST_TIMEOUT_MS || 60000);
const startChunk = Number(process.env.JEST_CI_START_CHUNK || 1);
const endChunk = process.env.JEST_CI_END_CHUNK
  ? Number(process.env.JEST_CI_END_CHUNK)
  : null;
const mandatoryIsolatedTestPatterns = [
  'pathway-event-delivery.deep.test.js',
  'pathway-projector-replay.deep.test.js',
];
const configuredIsolatedTestPatterns = String(
  process.env.JEST_CI_ISOLATED_TESTS
    || 'analytics-dashboard-tenant.deep.test.js,document-integrity.deep.test.js,pharmacy-ward-indent.test.js,interop-secret-tenant.deep.test.js,bed-service-c2-discharge.deep.test.js,future-proof-clinical-ai.test.js,admin-dashboard-stats-tenant.deep.test.js,hl7-outbound.deep.test.js,lab-walk-in.journey.test.js,user-profile-authz.deep.test.js,billing-add-void-atomicity.deep.test.js,billing-masters-contract.deep.test.js,billing-money-path-concurrency-deep.test.js,billing-v2-cashdrawer-paymentlinks-contract.deep.test.js,billing-v2-invoice-contract.deep.test.js,billing-v2-money-movement-contract.deep.test.js,billing-ward-indent-itemize-d58.test.js,billing.test.js,pathway-event-delivery.deep.test.js,pathway-projector-replay.deep.test.js',
)
  .split(',')
  .map((pattern) => pattern.trim())
  .filter(Boolean);
const isolatedTestPatterns = [...new Set([
  ...configuredIsolatedTestPatterns,
  ...mandatoryIsolatedTestPatterns,
])];
const passthroughArgs = process.argv.slice(2);
const maxBuffer = 64 * 1024 * 1024;

if (!existsSync(jestBin)) {
  console.error(`Jest binary not found at ${jestBin}. Run npm ci first.`);
  process.exit(1);
}

if (!Number.isInteger(chunkSize) || chunkSize < 1) {
  console.error(`JEST_CI_CHUNK_SIZE must be a positive integer; received ${process.env.JEST_CI_CHUNK_SIZE}`);
  process.exit(1);
}

if (!Number.isInteger(oldSpaceMb) || oldSpaceMb < 512) {
  console.error(`JEST_OLD_SPACE_MB must be an integer >= 512; received ${process.env.JEST_OLD_SPACE_MB}`);
  process.exit(1);
}

if (!Number.isInteger(testTimeoutMs) || testTimeoutMs < 5000) {
  console.error(`JEST_TEST_TIMEOUT_MS must be an integer >= 5000; received ${process.env.JEST_TEST_TIMEOUT_MS}`);
  process.exit(1);
}

if (!Number.isInteger(startChunk) || startChunk < 1) {
  console.error(`JEST_CI_START_CHUNK must be a positive integer; received ${process.env.JEST_CI_START_CHUNK}`);
  process.exit(1);
}

if (endChunk !== null && (!Number.isInteger(endChunk) || endChunk < startChunk)) {
  console.error(`JEST_CI_END_CHUNK must be an integer >= JEST_CI_START_CHUNK; received ${process.env.JEST_CI_END_CHUNK}`);
  process.exit(1);
}

// CI matrix sharding: JEST_CI_SHARD="k/N" interleaves chunks across N parallel
// jobs (chunk c -> shard ((c-1) % N) + 1; math pinned by
// src/tests/unit/jestShardPartition.test.js). Mutually exclusive with the
// START/END chunk window — composing them silently drops chunks, so refuse.
let shard = null;
try {
  shard = parseShardSpec(process.env.JEST_CI_SHARD);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
if (shard && (startChunk > 1 || endChunk !== null)) {
  console.error('JEST_CI_SHARD cannot be combined with JEST_CI_START_CHUNK/JEST_CI_END_CHUNK.');
  process.exit(1);
}

const nodeFlags = [
  `--max-old-space-size=${oldSpaceMb}`,
  '--experimental-vm-modules',
];

function run(args, options = {}) {
  return spawnSync(process.execPath, [...nodeFlags, jestBin, ...args], {
    cwd: backendRoot,
    env: { ...process.env, ...(options.env || {}) },
    ...(options.capture ? { encoding: 'utf8' } : {}),
    maxBuffer,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
}

function shouldRunIsolated(testFile) {
  return isolatedTestPatterns.some((pattern) => testFile.includes(pattern));
}

function executionGroupsForChunk(chunk) {
  const groups = [];
  let currentGroup = [];

  const flushCurrentGroup = () => {
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  };

  for (const testFile of chunk) {
    if (shouldRunIsolated(testFile)) {
      flushCurrentGroup();
      groups.push([testFile]);
    } else {
      currentGroup.push(testFile);
    }
  }

  flushCurrentGroup();
  return groups;
}

const listResult = run(['--runInBand', '--listTests', ...passthroughArgs], {
  capture: true,
});

if (listResult.status !== 0) {
  if (listResult.stdout) process.stdout.write(listResult.stdout);
  if (listResult.stderr) process.stderr.write(listResult.stderr);
  process.exit(listResult.status || 1);
}

const testFiles = (listResult.stdout || '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean)
  // Code-unit comparison, NOT localeCompare: shard coverage requires every
  // matrix runner to derive a byte-identical order, and localeCompare depends
  // on the Node build's ICU data (linguistic collation reorders this very
  // file list vs code-unit order). Code-unit order is deterministic across
  // platforms, locales, and Node/ICU versions by construction.
  .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

if (testFiles.length === 0) {
  console.error('Jest did not discover any test files.');
  process.exit(1);
}

const chunkCount = Math.ceil(testFiles.length / chunkSize);
const firstIndex = (startChunk - 1) * chunkSize;
const lastIndexExclusive = endChunk === null
  ? testFiles.length
  : Math.min(endChunk * chunkSize, testFiles.length);
if (firstIndex >= testFiles.length) {
  console.error(`JEST_CI_START_CHUNK ${startChunk} is beyond discovered chunk count ${chunkCount}.`);
  process.exit(1);
}
console.log(
  `Running ${testFiles.length} Jest files in ${chunkCount} chunk(s) ` +
  `of up to ${chunkSize} with ${oldSpaceMb} MB old-space and ${testTimeoutMs} ms timeout each.`
);
if (isolatedTestPatterns.length > 0) {
  console.log(`Isolating Jest files matching: ${isolatedTestPatterns.join(', ')}`);
}
if (startChunk > 1 || endChunk !== null) {
  console.log(`Running chunk window ${startChunk}-${endChunk ?? chunkCount} for local triage.`);
}
if (shard) {
  console.log(`Shard ${shard.shardIndex}/${shard.shardCount}: running chunks where (chunk-1) % ${shard.shardCount} === ${shard.shardIndex - 1}.`);
}

let executedChunks = 0;
for (let index = firstIndex; index < lastIndexExclusive; index += chunkSize) {
  const chunkNumber = Math.floor(index / chunkSize) + 1;
  if (shard && !chunkBelongsToShard(chunkNumber, shard.shardIndex, shard.shardCount)) {
    continue;
  }
  executedChunks += 1;
  const chunk = testFiles.slice(index, index + chunkSize);
  console.log(`\n[Jest CI] Chunk ${chunkNumber}/${chunkCount}: ${chunk.length} file(s)`);
  const executionGroups = executionGroupsForChunk(chunk);

  for (let groupIndex = 0; groupIndex < executionGroups.length; groupIndex += 1) {
    const group = executionGroups[groupIndex];
    if (executionGroups.length > 1) {
      console.log(`[Jest CI] Chunk ${chunkNumber}/${chunkCount} group ${groupIndex + 1}/${executionGroups.length}: ${group.length} file(s)`);
      for (const testFile of group) {
        console.log(`  - ${path.relative(backendRoot, testFile)}`);
      }
    }

    const result = run([
      '--runInBand',
      '--forceExit',
      `--testTimeout=${testTimeoutMs}`,
      ...passthroughArgs,
      '--runTestsByPath',
      ...group,
    ]);

    if (result.status !== 0) {
      console.error(`[Jest CI] Chunk ${chunkNumber}/${chunkCount} failed.`);
      process.exit(result.status || 1);
    }
  }
}

if (shard) {
  if (executedChunks === 0) {
    console.log(`\n[Jest CI] Shard ${shard.shardIndex}/${shard.shardCount}: no chunks assigned (suite has ${chunkCount} chunk(s)) — nothing to run.`);
  } else {
    console.log(`\n[Jest CI] Shard ${shard.shardIndex}/${shard.shardCount}: all ${executedChunks} assigned chunk(s) of ${chunkCount} passed.`);
  }
} else if (executedChunks === chunkCount) {
  console.log('\n[Jest CI] All chunks passed.');
} else {
  console.log(
    `\n[Jest CI] Partial chunk window passed: ${executedChunks} of ${chunkCount} discovered chunk(s) ran; ` +
    `${chunkCount - executedChunks} chunk(s) were not run.`,
  );
}
