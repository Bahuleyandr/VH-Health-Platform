#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function read(relPath) {
  return readFileSync(resolve(repoRoot, relPath), 'utf8');
}

function fail(message) {
  throw new Error(message);
}

function requirePattern(label, text, pattern) {
  if (!pattern.test(text)) {
    fail(`Missing zero-trust contract: ${label}`);
  }
}

function rejectPattern(label, text, pattern) {
  if (pattern.test(text)) {
    fail(`Forbidden zero-trust drift: ${label}`);
  }
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function parseJson(relPath) {
  try {
    return JSON.parse(read(relPath));
  } catch (err) {
    fail(`${relPath} is not valid JSON: ${err.message}`);
  }
}

function flattenHostnames(applications) {
  return applications.flatMap((app) => app.hostnames || []);
}

function validateAccessPolicy() {
  const relPath = 'infra/cloudflare/access/vhhealth-access-policy.json';
  const policy = parseJson(relPath);
  const groups = new Set((policy.groups || []).map((group) => group.key));
  const applications = policy.applications || [];
  const appKeys = new Set(applications.map((app) => app.key));
  const hostnames = new Set(flattenHostnames(applications));
  const policyKeys = new Set((policy.policyOrder || []).map((entry) => entry.key));

  assert(policy.schemaVersion === 1, 'Cloudflare Access policy schemaVersion must be 1');
  assert(policy.status === 'operator-applied', 'Cloudflare Access policy must stay operator-applied');
  assert(policy.zone === 'vhhealth.app', 'Cloudflare Access policy zone must be vhhealth.app');
  assert(policy.currentCni === 'canal', 'Zero-trust pack must record current CNI as canal');
  assert(policy.ciliumL7Migration?.status === 'plan-only', 'Cilium L7 must remain plan-only in this slice');
  assert(policy.ciliumL7Migration?.notAppliedInThisSlice === true, 'Cilium L7 must not be applied in this slice');

  for (const key of ['vhhealth-super-admins', 'vhhealth-admins', 'vhhealth-clinical-leads', 'vhhealth-break-glass']) {
    assert(groups.has(key), `Cloudflare Access group mapping missing ${key}`);
  }
  for (const key of ['admin-portal', 'api-admin', 'tenant-api']) {
    assert(appKeys.has(key), `Cloudflare Access application missing ${key}`);
  }
  for (const hostname of ['admin.vhhealth.app', 'api.vhhealth.app', '*.vhhealth.app']) {
    assert(hostnames.has(hostname), `Cloudflare Access hostname missing ${hostname}`);
  }
  assert(applications.every((app) => app.defaultDeny === true), 'Every Access application must be defaultDeny=true');
  assert(policyKeys.has('default-deny'), 'Cloudflare Access policy order must include default-deny');
  assert(
    (policy.policyOrder || []).some((entry) => entry.key === 'default-deny' && entry.decision === 'block'),
    'Cloudflare Access default-deny policy must block unmatched users',
  );
  assert(
    (policy.policyOrder || []).some((entry) => entry.key === 'break-glass-short-session' && entry.sessionDuration === '1h'),
    'Break-glass Access policy must keep a 1h session',
  );

  console.log(`[zero-trust] access policy OK (${relPath})`);
}

function validateNetworkPolicies() {
  const commonRel = 'infra/kubernetes/base/_common/network-policies.yaml';
  const redisRel = 'infra/kubernetes/base/redis/redis-sentinel.yaml';
  const minioRel = 'infra/kubernetes/base/minio/tenant.yaml';
  const tenantRel = 'infra/kubernetes/optional/tenant-network-boundary/network-policy.yaml';
  const namespaceRel = 'infra/kubernetes/optional/tenant-network-boundary/namespace.yaml';

  const common = read(commonRel);
  const redis = read(redisRel);
  const minio = read(minioRel);
  const tenant = read(tenantRel);
  const tenantNamespace = read(namespaceRel);

  for (const namespace of ['vhhealth', 'vhhealth-platform', 'vhhealth-monitoring', 'vhhealth-ingress', 'vhhealth-security']) {
    requirePattern(
      `${namespace} default deny`,
      common,
      new RegExp(`name:\\s*default-deny-all[\\s\\S]*namespace:\\s*${namespace}[\\s\\S]*policyTypes:\\s*\\[Ingress, Egress\\]`),
    );
  }

  requirePattern('current CNI documented as Canal', common, /RKE2\s+default\s+is\s+Canal/i);
  requirePattern('Cilium L7 documented as separate plan', common, /Cilium\s+L7\s+policy/i);
  rejectPattern('broad app namespace platform ingress allow', common, /name:\s*allow-app-to-platform/);

  requirePattern('CNPG allow policy name', common, /name:\s*allow-backend-to-cnpg/);
  requirePattern('CNPG selected by cluster label', common, /cnpg\.io\/cluster:\s*vhhealth-pg/);
  for (const workload of ['vhhealth-backend', 'vhhealth-backend-migrate', 'ward-downtime-packs']) {
    requirePattern(`CNPG ingress allows ${workload}`, common, new RegExp(`app\\.kubernetes\\.io/name:\\s*${workload}`));
  }
  requirePattern('CNPG ingress limited to port 5432', common, /port:\s*5432/);

  requirePattern('Redis policy keeps pod selectors', redis, /name:\s*redis-allow-app-ingress[\s\S]*podSelector:/);
  for (const workload of ['vhhealth-backend', 'vhhealth-admin']) {
    requirePattern(`Redis ingress allows ${workload}`, redis, new RegExp(`app\\.kubernetes\\.io/name:\\s*${workload}`));
  }
  requirePattern('Redis data port', redis, /port:\s*6379/);
  requirePattern('Redis sentinel port', redis, /port:\s*26379/);

  requirePattern('MinIO policy keeps pod selectors', minio, /name:\s*minio-allow-cluster-access[\s\S]*podSelector:/);
  for (const workload of ['vhhealth-backend', 'vhhealth-backend-r2-sync', 'ward-downtime-packs']) {
    requirePattern(`MinIO ingress allows ${workload}`, minio, new RegExp(`app\\.kubernetes\\.io/name:\\s*${workload}`));
  }
  requirePattern('MinIO API port', minio, /port:\s*9000/);

  requirePattern('Tenant namespace boundary label', tenantNamespace, /vhhealth\.app\/network-boundary:\s*tenant/);
  requirePattern('Tenant namespace slug label', tenantNamespace, /vhhealth\.app\/tenant-slug:\s*example/);
  requirePattern('Tenant default-deny policy', tenant, /name:\s*tenant-default-deny-all[\s\S]*policyTypes:\s*\[Ingress, Egress\]/);
  requirePattern('Tenant backend API egress opt-in label', tenant, /vhhealth\.app\/needs-backend-api:\s*"true"/);
  requirePattern('Tenant edge ingress opt-in label', tenant, /vhhealth\.app\/network-exposure:\s*edge/);

  console.log('[zero-trust] NetworkPolicy contracts OK');
}

function validateDocs() {
  const relPath = 'docs/ZERO_TRUST_NETWORK.md';
  const doc = read(relPath);
  for (const phrase of [
    'Cloudflare Access policy-as-code',
    'current RKE2 CNI remains `canal`',
    'Every `vhhealth-*` namespace has a default-deny',
    'Cilium L7 is deferred',
    'do not commit Cilium CRDs into the root base',
  ]) {
    requirePattern(`docs mention ${phrase}`, doc, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  console.log(`[zero-trust] docs OK (${relative(repoRoot, resolve(repoRoot, relPath))})`);
}

try {
  validateAccessPolicy();
  validateNetworkPolicies();
  validateDocs();
  console.log('[zero-trust] policy pack checks passed');
} catch (err) {
  console.error(`[zero-trust] FAIL: ${err.message}`);
  process.exit(1);
}
