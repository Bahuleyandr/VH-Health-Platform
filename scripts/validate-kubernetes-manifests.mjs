#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'infra/kubernetes/apps',
  'infra/kubernetes/overlays/dev',
  'infra/kubernetes/overlays/staging',
  'infra/kubernetes/overlays/prod',
];

function candidateNames(name) {
  return process.platform === 'win32' ? [name, `${name}.exe`] : [name];
}

function findBinary(name, envName) {
  const explicit = process.env[envName];
  if (explicit && existsSync(explicit)) {
    return explicit;
  }

  const localToolDir = process.platform === 'win32' ? 'D:\\Dev\\Tools\\kubetools' : '';
  const pathDirs = [
    ...String(process.env.PATH || '').split(delimiter),
    ...(localToolDir ? [localToolDir] : []),
  ];

  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const candidate of candidateNames(name)) {
      const fullPath = join(dir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  throw new Error(
    `${name} was not found. Install it on PATH or set ${envName} to the binary path.`,
  );
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : '';
    const stdout = result.stdout ? `\n${result.stdout.trim()}` : '';
    throw new Error(`${command} ${args.join(' ')} failed.${stderr}${stdout}`);
  }

  return result;
}

function requireInRendered(target, rendered, checks) {
  const missing = checks.filter(({ pattern }) => !pattern.test(rendered));
  if (missing.length > 0) {
    const labels = missing.map(({ label }) => `- ${label}`).join('\n');
    throw new Error(`${target} is missing required production manifest checks:\n${labels}`);
  }
}

function validateTarget(kustomize, kubeconform, target, tmpDir) {
  const rendered = run(kustomize, ['build', target]).stdout;
  const outputFile = join(tmpDir, `${target.replace(/[\\/]/g, '__')}.yaml`);
  writeFileSync(outputFile, rendered, 'utf8');

  if (target === 'infra/kubernetes/apps') {
    requireInRendered(target, rendered, [
      { label: 'backend Deployment', pattern: /kind:\s+Deployment[\s\S]*name:\s+vhhealth-backend/ },
      { label: 'backend Service', pattern: /kind:\s+Service[\s\S]*name:\s+vhhealth-backend/ },
      { label: 'backend migration Job', pattern: /kind:\s+Job[\s\S]*name:\s+vhhealth-backend-migrate/ },
      { label: 'backend liveness probe uses /health/live', pattern: /livenessProbe:[\s\S]*path:\s+\/health\/live/ },
      { label: 'backend readiness probe uses /health/ready', pattern: /readinessProbe:[\s\S]*path:\s+\/health\/ready/ },
      { label: 'backend release worker cap is CLUSTER_WORKERS=2', pattern: /name:\s+CLUSTER_WORKERS[\s\S]*value:\s+"2"/ },
      { label: 'backend secret reference', pattern: /secretRef:[\s\S]*name:\s+vhhealth-backend-env/ },
      { label: 'admin secret reference', pattern: /secretRef:[\s\S]*name:\s+vhhealth-admin-env/ },
    ]);
  }

  const kubeconformResult = run(kubeconform, [
    '-strict',
    '-ignore-missing-schemas',
    '-summary',
    outputFile,
  ]);

  const summary = kubeconformResult.stdout.trim() || kubeconformResult.stderr.trim();
  console.log(`[ok] ${target}`);
  if (summary) console.log(summary);
}

function main() {
  const kustomize = findBinary('kustomize', 'KUSTOMIZE_BIN');
  const kubeconform = findBinary('kubeconform', 'KUBECONFORM_BIN');
  const tmpDir = mkdtempSync(join(tmpdir(), 'vhhealth-k8s-'));

  try {
    for (const target of targets) {
      validateTarget(kustomize, kubeconform, target, tmpDir);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
