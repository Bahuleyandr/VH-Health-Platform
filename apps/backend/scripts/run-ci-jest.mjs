#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '..');
const jestBin = path.join(backendRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const chunkSize = Number(process.env.JEST_CI_CHUNK_SIZE || 45);
const oldSpaceMb = Number(process.env.JEST_OLD_SPACE_MB || 3072);
const passthroughArgs = process.argv.slice(2);

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

const nodeFlags = [
  `--max-old-space-size=${oldSpaceMb}`,
  '--experimental-vm-modules',
];

function run(args, options = {}) {
  return spawnSync(process.execPath, [...nodeFlags, jestBin, ...args], {
    cwd: backendRoot,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
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
  .filter(Boolean);

if (testFiles.length === 0) {
  console.error('Jest did not discover any test files.');
  process.exit(1);
}

const chunkCount = Math.ceil(testFiles.length / chunkSize);
console.log(
  `Running ${testFiles.length} Jest files in ${chunkCount} chunk(s) ` +
  `of up to ${chunkSize} with ${oldSpaceMb} MB old-space each.`
);

for (let index = 0; index < testFiles.length; index += chunkSize) {
  const chunkNumber = Math.floor(index / chunkSize) + 1;
  const chunk = testFiles.slice(index, index + chunkSize);
  console.log(`\n[Jest CI] Chunk ${chunkNumber}/${chunkCount}: ${chunk.length} file(s)`);
  const result = run([
    '--runInBand',
    '--forceExit',
    ...passthroughArgs,
    '--runTestsByPath',
    ...chunk,
  ]);

  if (result.status !== 0) {
    console.error(`[Jest CI] Chunk ${chunkNumber}/${chunkCount} failed.`);
    process.exit(result.status || 1);
  }
}

console.log('\n[Jest CI] All chunks passed.');
