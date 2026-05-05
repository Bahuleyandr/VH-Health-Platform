#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

const stageOrder = ['security', 'backend', 'admin', 'flutter', 'infra'];
const aliases = new Map([
  ['all', stageOrder],
  ['full', stageOrder],
  ['mobile', ['flutter']],
  ['k8s', ['infra']],
  ['kubernetes', ['infra']],
]);

const ciEnv = {
  NEXT_PUBLIC_API_URL: 'http://localhost:5000',
  NEXT_PUBLIC_API_KEY: 'test-api-key',
  NEXT_PUBLIC_APP_NAME: 'VHHealth Admin',
  NEXT_PUBLIC_APP_ORIGIN: 'http://localhost:3000',
  NEXT_PUBLIC_WS_URL: 'ws://localhost:5000',
  NEXT_PUBLIC_X_API_KEY: 'test-api-key',
};

function commandSpec(command, args) {
  if (isWindows && command === 'dart') {
    const flutterRoot = process.env.FLUTTER_ROOT || 'D:\\Dev\\Tools\\flutter';
    const dartExe = join(flutterRoot, 'bin', 'cache', 'dart-sdk', 'bin', 'dart.exe');
    if (existsSync(dartExe)) return { command: dartExe, args };
  }
  if (isWindows && ['npm', 'flutter', 'melos'].includes(command)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', command, ...args],
    };
  }
  return { command, args };
}

function parseList(value) {
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .flatMap((entry) => aliases.get(entry) || [entry]);
}

function usage() {
  console.log(`Usage: node scripts/local-ci.mjs [--only=a,b] [--skip=a,b]

Stages: ${stageOrder.join(', ')}

Examples:
  node scripts/local-ci.mjs
  node scripts/local-ci.mjs --only=security,backend
  node scripts/local-ci.mjs --skip=flutter
`);
}

function parseArgs() {
  let selected = [...stageOrder];
  const skipped = new Set();

  for (const arg of process.argv.slice(2)) {
    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }
    if (arg.startsWith('--only=')) {
      selected = parseList(arg.slice('--only='.length));
      continue;
    }
    if (arg.startsWith('--skip=')) {
      for (const stage of parseList(arg.slice('--skip='.length))) skipped.add(stage);
      continue;
    }
    console.error(`Unknown argument: ${arg}`);
    usage();
    process.exit(2);
  }

  const unknown = [...new Set([...selected, ...skipped])].filter(
    (stage) => !stageOrder.includes(stage),
  );
  if (unknown.length > 0) {
    console.error(`Unknown local CI stage(s): ${unknown.join(', ')}`);
    usage();
    process.exit(2);
  }

  return stageOrder.filter((stage) => selected.includes(stage) && !skipped.has(stage));
}

function run(command, args, options = {}) {
  const started = Date.now();
  const displayCwd = options.cwd ? options.cwd.replace(`${repoRoot}\\`, '').replace(`${repoRoot}/`, '') : '.';
  console.log(`\n$ ${command} ${args.join(' ')}  [${displayCwd}]`);

  const spec = commandSpec(command, args);
  const result = spawnSync(spec.command, spec.args, {
    cwd: options.cwd || repoRoot,
    env: { ...process.env, ...(options.env || {}) },
    stdio: 'inherit',
    shell: false,
  });

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed after ${seconds}s`);
  }
  console.log(`ok (${seconds}s)`);
}

const stages = {
  security() {
    run('git', ['diff', '--check']);
    run(process.execPath, ['scripts/gitleaks-scan.mjs', 'worktree']);
    run(process.execPath, ['scripts/gitleaks-scan.mjs', 'range']);
  },
  backend() {
    const cwd = resolve(repoRoot, 'apps/backend');
    run('docker', ['version', '--format', '{{.Server.Version}}']);
    run('npm', ['run', 'ci'], { cwd });
  },
  admin() {
    const cwd = resolve(repoRoot, 'apps/admin');
    run('npm', ['audit', '--audit-level=high'], { cwd, env: ciEnv });
    run('npm', ['run', 'lint'], { cwd, env: ciEnv });
    run('npm', ['run', 'type-check'], { cwd, env: ciEnv });
    run('npm', ['test'], { cwd, env: ciEnv });
    run('npm', ['run', 'build'], { cwd, env: ciEnv });
    run('npm', ['run', 'check:clinical-ai-bundle'], { cwd, env: ciEnv });
  },
  flutter() {
    run('dart', ['pub', 'get']);
    run('dart', ['run', 'melos', 'bootstrap']);
    run('dart', ['run', 'melos', 'run', 'format']);
    run('dart', ['run', 'melos', 'run', 'analyze']);
    run('dart', ['run', 'melos', 'run', 'test']);
  },
  infra() {
    run(process.execPath, ['scripts/validate-kubernetes-manifests.mjs']);
  },
};

const selectedStages = parseArgs();

if (selectedStages.length === 0) {
  console.error('No local CI stages selected.');
  process.exit(2);
}

console.log(`VH Health local CI: ${selectedStages.join(', ')}`);
const startedAt = Date.now();

for (const stage of selectedStages) {
  console.log(`\n=== ${stage.toUpperCase()} ===`);
  stages[stage]();
}

const totalSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nLocal CI passed in ${totalSeconds}s.`);
