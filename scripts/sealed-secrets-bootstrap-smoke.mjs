import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { validateBootstrap } from './validate-sealed-secrets-bootstrap.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(repoRoot, 'infra', 'kubernetes', 'base', 'sealed-secrets');
const helper = path.join(repoRoot, 'scripts', 'bootstrap-sealed-secrets.sh');
const requireCluster = process.argv.includes('--require-cluster');
const autoCluster = process.argv.length === 2 || process.argv.includes('--auto');

if (process.argv.length > 3 || (!requireCluster && !autoCluster)) {
  console.error(
    'Usage: node scripts/sealed-secrets-bootstrap-smoke.mjs [--auto|--require-cluster]',
  );
  process.exit(2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: options.encoding,
    stdio: options.stdio ?? (options.encoding ? 'pipe' : 'inherit'),
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

function available(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
  });
  return result.status === 0;
}

function firstAvailable(candidates, args) {
  for (const candidate of candidates.filter(Boolean)) {
    if (available(candidate, args)) return candidate;
  }
  return null;
}

const localKubeTools = process.platform === 'win32' ? 'D:\\Dev\\Tools\\kubetools' : '';
const kustomize = firstAvailable(
  [process.env.KUSTOMIZE_BIN, localKubeTools && path.join(localKubeTools, 'kustomize.exe'), 'kustomize'],
  ['version'],
);
if (!kustomize) throw new Error('kustomize is required for the mandatory bootstrap render proof');

const rendered = run(kustomize, ['build', target], { encoding: 'utf8' }).stdout;
validateBootstrap(rendered);
console.log('PASS: mandatory Sealed Secrets bootstrap render and identity proof.');

const kind = firstAvailable([process.env.KIND_BIN, 'kind'], ['version']);
const docker = firstAvailable([process.env.DOCKER_BIN, 'docker'], ['info']);
const kubectl = firstAvailable(
  [
    process.env.KUBECTL_BIN,
    process.platform === 'win32'
      ? 'D:\\Dev\\Tools\\Docker\\Docker\\resources\\bin\\kubectl.exe'
      : '',
    'kubectl',
  ],
  ['version', '--client'],
);

const missing = [
  !kind && 'kind',
  !docker && 'a reachable Docker runtime',
  !kubectl && 'kubectl',
].filter(Boolean);

if (missing.length > 0) {
  const message =
    `ephemeral-cluster proof unavailable (${missing.join(', ')}); ` +
    'the mandatory render and negative identity contract still ran';
  if (requireCluster) throw new Error(message);
  console.log(`SKIP: ${message}.`);
  process.exit(0);
}

if (process.platform === 'win32') {
  const message = 'ephemeral-cluster proof requires a POSIX shell for the bootstrap helper';
  if (requireCluster) throw new Error(message);
  console.log(`SKIP: ${message}; the mandatory render and negative identity contract still ran.`);
  process.exit(0);
}

const temp = mkdtempSync(path.join(tmpdir(), 'vhhealth-sealed-kind-'));
const kubeconfig = path.join(temp, 'kubeconfig');
const clusterName = `vhhealth-sealed-${process.pid}-${Date.now().toString(36)}`;
let clusterAttempted = false;

try {
  clusterAttempted = true;
  run(kind, ['create', 'cluster', '--name', clusterName, '--kubeconfig', kubeconfig, '--wait', '90s']);

  const smokeEnv = {
    KUBECONFIG: kubeconfig,
    KUSTOMIZE_BIN: kustomize,
    KUBECTL_BIN: kubectl,
    NODE_BIN: process.execPath,
  };
  run('bash', [helper, '--apply'], { env: smokeEnv });

  for (const args of [
    ['get', 'namespace', 'vhhealth-security'],
    ['get', 'customresourcedefinition', 'sealedsecrets.bitnami.com'],
    ['-n', 'vhhealth-security', 'get', 'serviceaccount', 'sealed-secrets'],
    ['-n', 'vhhealth-security', 'get', 'service', 'sealed-secrets'],
    ['-n', 'vhhealth-security', 'get', 'deployment', 'sealed-secrets'],
    ['get', 'clusterrolebinding', 'sealed-secrets'],
  ]) {
    run(kubectl, args, { env: { KUBECONFIG: kubeconfig } });
  }

  const serviceMonitor = spawnSync(
    kubectl,
    ['get', 'customresourcedefinition', 'servicemonitors.monitoring.coreos.com'],
    {
      cwd: repoRoot,
      env: { ...process.env, KUBECONFIG: kubeconfig },
      encoding: 'utf8',
      stdio: 'pipe',
    },
  );
  if (serviceMonitor.status === 0) {
    throw new Error('fresh cluster unexpectedly already has the ServiceMonitor CRD');
  }
  const missingServiceMonitor = `${serviceMonitor.stderr ?? ''}\n${serviceMonitor.stdout ?? ''}`;
  if (!/not found/i.test(missingServiceMonitor)) {
    throw new Error(
      'could not prove the ServiceMonitor CRD is absent: ' + missingServiceMonitor.trim(),
    );
  }

  console.log('PASS: fresh kind cluster installed Sealed Secrets before any monitoring CRD existed.');
} finally {
  let cleanupError = null;
  if (clusterAttempted) {
    const deleted = spawnSync(kind, ['delete', 'cluster', '--name', clusterName], {
      cwd: repoRoot,
      env: { ...process.env, KUBECONFIG: kubeconfig },
      stdio: 'inherit',
      shell: false,
    });
    if (deleted.error || deleted.status !== 0) {
      cleanupError = new Error(
        deleted.error?.message ?? `kind failed to delete disposable cluster ${clusterName}`,
      );
    } else {
      const remaining = spawnSync(kind, ['get', 'clusters'], {
        cwd: repoRoot,
        env: { ...process.env, KUBECONFIG: kubeconfig },
        encoding: 'utf8',
        stdio: 'pipe',
        shell: false,
      });
      if (remaining.error || remaining.status !== 0) {
        cleanupError = new Error(
          remaining.error?.message ?? 'kind could not verify disposable cluster cleanup',
        );
      } else if (remaining.stdout.split(/\r?\n/).includes(clusterName)) {
        cleanupError = new Error(`disposable kind cluster ${clusterName} still exists after cleanup`);
      }
    }
  }
  if (existsSync(temp)) rmSync(temp, { recursive: true, force: true });
  if (cleanupError) throw cleanupError;
}
