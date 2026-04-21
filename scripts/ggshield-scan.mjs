#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliArgs = process.argv.slice(2);
const mode = cliArgs.find((arg) => !arg.startsWith('--')) || 'worktree';
const optional = cliArgs.includes('--optional') || process.env.GGSHIELD_OPTIONAL === '1';

const ggshieldBin = process.env.GGSHIELD_BIN ||
  (process.platform === 'win32' && existsSync('D:\\Dev\\Tools\\ggshield\\ggshield.exe')
    ? 'D:\\Dev\\Tools\\ggshield\\ggshield.exe'
    : 'ggshield');

const commonScanOptions = ['--no-check-for-updates'];
const pathScanOptions = [
  '--recursive',
  '--yes',
  '--use-gitignore',
  '--exclude',
  '.git/**',
  '--exclude',
  '.dart_tool/**',
  '--exclude',
  'node_modules/**',
  '--exclude',
  'apps/*/.next/**',
  '--exclude',
  'apps/*/build/**',
  '--exclude',
  'packages/*/build/**',
  '--exclude',
  'output/**',
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
}

function getOutput(command, args) {
  const result = run(command, args, { capture: true });
  if (result.status !== 0) return '';
  return result.stdout.trim();
}

function isZeroSha(value) {
  return /^0{40}$/.test(value || '');
}

function findCommitRange() {
  if (process.env.GGSHIELD_COMMIT_RANGE) return process.env.GGSHIELD_COMMIT_RANGE;

  const eventName = process.env.GITHUB_EVENT_NAME;
  const prBase = process.env.PR_BASE_SHA;
  const prHead = process.env.PR_HEAD_SHA || process.env.GITHUB_SHA;
  if (eventName === 'pull_request' && prBase && prHead) {
    return `${prBase}..${prHead}`;
  }

  const pushBefore = process.env.PUSH_BEFORE_SHA;
  const pushHead = process.env.GITHUB_SHA;
  if (pushBefore && pushHead && !isZeroSha(pushBefore)) {
    return `${pushBefore}..${pushHead}`;
  }

  const upstream = getOutput('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) return `${upstream}..HEAD`;

  const parent = getOutput('git', ['rev-parse', '--verify', 'HEAD~1']);
  return parent ? 'HEAD~1..HEAD' : '';
}

function hasCommits(commitRange) {
  if (!commitRange) return false;
  const result = run('git', ['rev-list', '--count', commitRange], { capture: true });
  if (result.status !== 0) return true;
  return Number.parseInt(result.stdout.trim(), 10) > 0;
}

function isMissingAuth(result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  return text.includes('A GitGuardian API key is needed to use ggshield') ||
    text.includes('ggshield auth login');
}

function relay(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function finish(result) {
  if (result.error) {
    if (optional && result.error.code === 'ENOENT') {
      console.log('GitGuardian scan skipped: ggshield is not installed.');
      process.exit(0);
    }
    console.error(`GitGuardian scan failed to start: ${result.error.message}`);
    process.exit(1);
  }

  if (optional && result.status !== 0 && isMissingAuth(result)) {
    console.log('GitGuardian scan skipped: run `ggshield auth login` or set GITGUARDIAN_API_KEY.');
    process.exit(0);
  }

  relay(result);
  process.exit(result.status ?? 1);
}

let args;
if (mode === 'worktree') {
  args = ['secret', 'scan', 'path', ...commonScanOptions, ...pathScanOptions, '.'];
} else if (mode === 'staged') {
  args = ['secret', 'scan', 'pre-commit', ...commonScanOptions];
} else if (mode === 'range') {
  const commitRange = findCommitRange();
  if (!hasCommits(commitRange)) {
    console.log('GitGuardian range scan skipped: no commits in comparison range.');
    process.exit(0);
  }
  args = ['secret', 'scan', 'commit-range', ...commonScanOptions, commitRange];
} else if (mode === 'ci') {
  args = ['secret', 'scan', 'ci', ...commonScanOptions];
} else if (mode === 'repo') {
  args = ['secret', 'scan', 'repo', ...commonScanOptions, '.'];
} else {
  console.error(`Unknown GitGuardian scan mode: ${mode}`);
  process.exit(2);
}

finish(run(ggshieldBin, args));
