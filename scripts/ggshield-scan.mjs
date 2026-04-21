#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
const pathSkipPatterns = [
  /^apps\/admin\/\.env\.example$/,
  /^apps\/backend\/backups\//,
  /^apps\/backend\/src\/docs\/swagger.*\.json$/,
  /^apps\/patient\/(macos|windows|ios|linux|web)\//,
  /^apps\/patient\/assets\/fonts\//,
  /^apps\/patient\/local_plugins\//,
  /^apps\/staff\/(macos|windows|ios|linux|web)\//,
  /^packages\/vhhealth_core\/lib\/api\/generated\//,
  /^apps\/[^/]+\/build\//,
  /^packages\/[^/]+\/build\//,
  /\.zip$/i,
  /\.tar\.gz$/i,
  /\.tgz$/i,
  /\.gz$/i,
  /\.(png|jpg|jpeg|gif|webp|ico|pdf|xib)$/i,
  /\.(ttf|otf|woff|woff2|lnk)$/i,
];

const pathIncludePatterns = [
  /^\.github\//,
  /^scripts\//,
  /^apps\/admin\/(src|docs|scripts|public)\//,
  /^apps\/backend\/(src|docs|deploy|migrations|prisma|scripts)\//,
  /^apps\/patient\/(android|lib|test)\//,
  /^apps\/staff\/(android|lib|test)\//,
  /^packages\/vhhealth_core\/(lib|test)\//,
  /(^|\/)(Dockerfile|docker-compose[^/]*\.ya?ml|package\.json|package-lock\.json|pubspec\.ya?ml|pubspec\.lock|melos\.ya?ml|lefthook\.yml|CLAUDE\.md|README\.md|\.gitignore|\.gitleaks\.toml|.*\.env\.example|.*\.properties|.*\.gradle\.kts|.*\.plist)$/i,
  /\.(js|mjs|cjs|ts|tsx|jsx|dart|json|ya?ml|toml|md|sql|ps1|sh|html|css|scss|xml|txt)$/i,
];
function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : ['ignore', 'pipe', 'pipe'],
    input: options.input,
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

function listAllCandidatePaths() {
  const result = run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { capture: true });
  if (result.status !== 0) {
    console.error(result.stderr || 'Unable to list git-tracked paths for GitGuardian scan.');
    process.exit(result.status ?? 1);
  }

  return result.stdout
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}

function listChangedCandidatePaths() {
  const candidates = new Set();
  const upstream = getOutput('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (upstream) {
    const diff = getOutput('git', ['diff', '--name-only', `${upstream}..HEAD`]);
    diff.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).forEach((path) => candidates.add(path));
  }

  const unstaged = getOutput('git', ['diff', '--name-only']);
  unstaged.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).forEach((path) => candidates.add(path));

  const staged = getOutput('git', ['diff', '--name-only', '--cached']);
  staged.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).forEach((path) => candidates.add(path));

  const untracked = getOutput('git', ['ls-files', '--others', '--exclude-standard']);
  untracked.split(/\r?\n/).map((path) => path.trim()).filter(Boolean).forEach((path) => candidates.add(path));

  return [...candidates];
}

function filteredPathListArg(paths, label) {
  const existingPaths = paths.filter((path) => existsSync(resolve(repoRoot, path)));

  const ignored = run('git', ['check-ignore', '--no-index', '--stdin'], {
    capture: true,
    input: `${existingPaths.join('\n')}\n`,
  });
  const ignoredPaths = new Set(
    (ignored.stdout || '')
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter(Boolean)
  );

  const scannablePaths = existingPaths.filter((path) =>
    !ignoredPaths.has(path) &&
    !pathSkipPatterns.some((pattern) => pattern.test(path)) &&
    pathIncludePatterns.some((pattern) => pattern.test(path))
  );

  if (scannablePaths.length === 0) {
    console.log(`GitGuardian ${label} scan skipped: no files to scan.`);
    process.exit(0);
  }

  const tempDir = mkdtempSync(resolve(tmpdir(), 'vhhealth-ggshield-'));
  const pathList = resolve(tempDir, 'paths.txt');
  writeFileSync(pathList, `${scannablePaths.join('\n')}\n`, 'utf8');
  return { arg: `@${pathList}`, tempDir };
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
let cleanupDir;
if (mode === 'worktree') {
  const pathList = filteredPathListArg(listChangedCandidatePaths(), 'worktree');
  cleanupDir = pathList.tempDir;
  args = ['secret', 'scan', 'path', ...commonScanOptions, '--yes', pathList.arg];
} else if (mode === 'all-worktree') {
  const pathList = filteredPathListArg(listAllCandidatePaths(), 'all-worktree');
  cleanupDir = pathList.tempDir;
  args = ['secret', 'scan', 'path', ...commonScanOptions, '--yes', pathList.arg];
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

const result = run(ggshieldBin, args);
if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
finish(result);
