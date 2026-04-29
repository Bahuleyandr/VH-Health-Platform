#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const writeMode = process.argv.includes('--write');
const useShell = process.platform === 'win32';
const gitResult = spawnSync('git', ['ls-files', '--', '*.dart'], {
  encoding: 'utf8',
  shell: false,
});

if (gitResult.status !== 0) {
  process.stderr.write(gitResult.stderr || 'Failed to list tracked Dart files.\n');
  process.exit(gitResult.status ?? 1);
}

const files = gitResult.stdout
  .split(/\r?\n/)
  .map((file) => file.trim())
  .filter(Boolean);

if (files.length === 0) {
  console.log('No tracked Dart files found.');
  process.exit(0);
}

const baseArgs = ['format'];
if (!writeMode) {
  baseArgs.push('--output=none', '--set-exit-if-changed');
}

const chunkSize = 80;
let exitCode = 0;
for (let index = 0; index < files.length; index += chunkSize) {
  const chunk = files.slice(index, index + chunkSize);
  const result = spawnSync('dart', [...baseArgs, ...chunk], {
    encoding: 'utf8',
    stdio: 'inherit',
    shell: useShell,
  });

  if (result.status !== 0) {
    exitCode = result.status ?? 1;
    break;
  }
}

process.exit(exitCode);
