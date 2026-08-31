#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] || 'worktree';

const gitleaksBin = process.env.GITLEAKS_BIN ||
  (process.platform === 'win32' && existsSync('D:\\Dev\\Tools\\gitleaks\\gitleaks.exe')
    ? 'D:\\Dev\\Tools\\gitleaks\\gitleaks.exe'
    : 'gitleaks');

const commonArgs = [
  '--config',
  '.gitleaks.toml',
  '--redact=100',
  '--no-banner',
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
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

function findLogOpts() {
  if (process.env.GITLEAKS_LOG_OPTS) return process.env.GITLEAKS_LOG_OPTS;

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

function hasCommits(logOpts) {
  if (!logOpts) return false;
  const result = run('git', ['rev-list', '--count', logOpts], { capture: true });
  if (result.status !== 0) return true;
  return Number.parseInt(result.stdout.trim(), 10) > 0;
}

let args;
if (mode === 'worktree') {
  args = ['dir', '.', ...commonArgs];
} else if (mode === 'staged') {
  args = ['git', '.', '--staged', ...commonArgs];
} else if (mode === 'range') {
  const logOpts = findLogOpts();
  if (!hasCommits(logOpts)) {
    console.log('Gitleaks range scan skipped: no commits in comparison range.');
    process.exit(0);
  }
  args = ['git', '.', '--log-opts', logOpts, ...commonArgs];
} else {
  console.error(`Unknown gitleaks scan mode: ${mode}`);
  process.exit(2);
}

const reportDir = mkdtempSync(join(tmpdir(), 'vh-gitleaks-'));
const reportPath = join(reportDir, 'report.json');

try {
  const result = run(gitleaksBin, [
    ...args,
    '--report-format',
    'json',
    '--report-path',
    reportPath,
  ]);

  if (result.status !== 0 && existsSync(reportPath)) {
    const findings = JSON.parse(readFileSync(reportPath, 'utf8'));
    const safeFindings = findings.map((finding) => ({
      ruleId: finding.RuleID,
      file: finding.File,
      line: finding.StartLine,
      commit: finding.Commit || undefined,
    }));
    console.error(`Gitleaks safe findings: ${JSON.stringify(safeFindings)}`);
  }

  process.exitCode = result.status ?? 1;
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
