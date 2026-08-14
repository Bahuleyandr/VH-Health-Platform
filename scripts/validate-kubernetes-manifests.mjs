#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(thisFile), '..');

const targets = [
  'infra/kubernetes/apps',
  // Held bedside-device ingress tree — composed by no overlay yet, but its
  // manifests must stay valid so activation does not start from rot.
  'infra/kubernetes/base/device-gateway',
  'infra/kubernetes/optional/tenant-network-boundary',
  'infra/kubernetes/overlays/staging/apps',
  'infra/kubernetes/overlays/dev',
  'infra/kubernetes/overlays/staging',
  'infra/kubernetes/overlays/prod',
];

// kubeconform's default schema catalog does not contain these repository-owned
// or operator-provided CRDs. Keep this as a full-GVK allowlist: a new or
// misspelled custom resource must fail validation instead of being hidden by
// -ignore-missing-schemas. ObjectStore's essential C1.1 fields are checked
// below because the Barman Cloud Plugin CRD is installed operator-side.
const knownExternalGvks = [
  'apiextensions.k8s.io/v1/CustomResourceDefinition',
  'argoproj.io/v1alpha1/Application',
  'argoproj.io/v1alpha1/AppProject',
  'barmancloud.cnpg.io/v1/ObjectStore',
  'bitnami.com/v1alpha1/SealedSecret',
  'cert-manager.io/v1/Certificate',
  'cert-manager.io/v1/ClusterIssuer',
  'kyverno.io/v1/ClusterPolicy',
  'minio.min.io/v2/Tenant',
  'monitoring.coreos.com/v1/PrometheusRule',
  'monitoring.coreos.com/v1/ServiceMonitor',
  'postgresql.cnpg.io/v1/Cluster',
  'postgresql.cnpg.io/v1/Pooler',
  'postgresql.cnpg.io/v1/ScheduledBackup',
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

function rejectInRendered(target, rendered, checks) {
  const present = checks.filter(({ pattern }) => pattern.test(rendered));
  if (present.length > 0) {
    const labels = present.map(({ label }) => `- ${label}`).join('\n');
    throw new Error(`${target} contains forbidden manifest constructs:\n${labels}`);
  }
}

function renderedDocuments(rendered) {
  return rendered
    .split(/^---\s*$/m)
    .map((document) => document.trim())
    .filter(Boolean);
}

export function assertNoIngressClassParameters(rendered, target = 'render') {
  const ingressClasses = renderedDocuments(rendered).filter(
    (document) =>
      /^apiVersion:\s+networking\.k8s\.io\/v1\s*$/m.test(document) &&
      /^kind:\s+IngressClass\s*$/m.test(document),
  );
  const withParameters = ingressClasses.filter((document) =>
    /^\s{2}parameters:\s*(?:.*)$/m.test(document),
  );
  if (withParameters.length > 0) {
    throw new Error(
      `${target} contains IngressClass spec.parameters, but this repository defines no ` +
        'IngressClassParameters resource/controller contract.',
    );
  }
}

function requireObjectStoreContract(target, rendered) {
  if (target !== 'infra/kubernetes/overlays/prod') return;

  const objectStores = renderedDocuments(rendered).filter(
    (document) =>
      /^apiVersion:\s+barmancloud\.cnpg\.io\/v1\s*$/m.test(document) &&
      /^kind:\s+ObjectStore\s*$/m.test(document),
  );

  if (objectStores.length !== 1) {
    throw new Error(
      `${target} must render exactly one barmancloud.cnpg.io/v1 ObjectStore; found ${objectStores.length}.`,
    );
  }

  requireInRendered(target, objectStores[0], [
    { label: 'ObjectStore metadata.name', pattern: /^metadata:\s*$[\s\S]*?^\s{2}name:\s+\S+/m },
    {
      label: 'ObjectStore spec.configuration',
      pattern: /^spec:\s*$[\s\S]*?^\s{2}configuration:\s*$/m,
    },
    { label: 'ObjectStore destinationPath', pattern: /^\s{4}destinationPath:\s+s3:\/\/\S+/m },
    { label: 'ObjectStore HTTPS endpointURL', pattern: /^\s{4}endpointURL:\s+https:\/\/\S+/m },
    { label: 'ObjectStore s3Credentials', pattern: /^\s{4}s3Credentials:\s*$/m },
  ]);
}

function validateTarget(kustomize, kubeconform, target, tmpDir) {
  const rendered = run(kustomize, ['build', target]).stdout;
  const outputFile = join(tmpDir, `${target.replace(/[\\/]/g, '__')}.yaml`);
  writeFileSync(outputFile, rendered, 'utf8');

  rejectInRendered(target, rendered, [
    {
      label: 'unsupported/dangling IngressClassParameters reference',
      pattern: /^\s*kind:\s+IngressClassParameters\s*$/m,
    },
  ]);
  assertNoIngressClassParameters(rendered, target);
  requireObjectStoreContract(target, rendered);

  if (target === 'infra/kubernetes/apps') {
    requireInRendered(target, rendered, [
      { label: 'backend Deployment', pattern: /kind:\s+Deployment[\s\S]*name:\s+vhhealth-backend/ },
      { label: 'backend Service', pattern: /kind:\s+Service[\s\S]*name:\s+vhhealth-backend/ },
      { label: 'backend migration Job', pattern: /kind:\s+Job[\s\S]*name:\s+vhhealth-backend-migrate/ },
      { label: 'backend liveness probe uses /health/live', pattern: /livenessProbe:[\s\S]*path:\s+\/health\/live/ },
      {
        label: 'backend readiness probe authenticates /health/ready with monitoring token',
        pattern: /readinessProbe:[\s\S]*exec:[\s\S]*MONITORING_TOKEN[\s\S]*\/health\/ready[\s\S]*x-monitoring-token/,
      },
      { label: 'backend release worker cap is CLUSTER_WORKERS=2', pattern: /name:\s+CLUSTER_WORKERS[\s\S]*value:\s+"2"/ },
      { label: 'backend secret reference', pattern: /secretRef:[\s\S]*name:\s+vhhealth-backend-env/ },
      { label: 'admin secret reference', pattern: /secretRef:[\s\S]*name:\s+vhhealth-admin-env/ },
    ]);
  }

  const kubeconformResult = run(kubeconform, [
    '-strict',
    '-skip',
    knownExternalGvks.join(','),
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

if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main();
}
