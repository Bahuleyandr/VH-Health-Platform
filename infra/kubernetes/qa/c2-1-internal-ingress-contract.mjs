#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const baseline = 'ed5167385d44853b4f0adae497a62c92418340de';
const controllerDigest =
  'registry.k8s.io/ingress-nginx/controller:v1.11.3@sha256:' +
  'd56f135b6462cfc476447cfe564b83a45e8bb7da2774963b00d12161112270b7';

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).replace(/\r\n/g, '\n');
}

function render(target) {
  const configured = process.env.KUSTOMIZE_BIN;
  if (configured) return run(configured, ['build', target]);
  try {
    return run('kustomize', ['build', target]);
  } catch {
    return run('kubectl', ['kustomize', target]);
  }
}

function documents(text) {
  return text
    .split(/\n---\s*\n/)
    .map((document) => document.trim())
    .filter(Boolean);
}

function field(document, key) {
  const match = document.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, 'm'));
  return match?.[1]?.trim();
}

function metadataName(document) {
  const match = document.match(
    /^metadata:\s*\n(?:(?: {2}.*)?\n)*? {2}name:\s*["']?([^"'#\n]+)/m,
  );
  return match?.[1]?.trim();
}

function manifest(document) {
  return { document, kind: field(document, 'kind'), name: metadataName(document) };
}

function sourceAtBaseline(path) {
  return run('git', ['show', `${baseline}:${path}`]);
}

function removeInternalClass(source) {
  return documents(source)
    .filter(
      (document) =>
        !(
          /^kind:\s*IngressClass\s*$/m.test(document) &&
          /^ {2}name:\s*nginx-internal\s*$/m.test(document)
        ),
    )
    .join('\n---\n')
    .concat('\n');
}

function behaviorLines(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*(?:#.*)?$/.test(line))
    .join('\n');
}

function walkYaml(root) {
  const output = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) output.push(...walkYaml(path));
    else if (/\.ya?ml(?:\.example)?$/.test(entry)) output.push(path);
  }
  return output;
}

const publicPath = 'infra/kubernetes/base/ingress-nginx/ingress-nginx.yaml';
const internalPath =
  'infra/kubernetes/base/ingress-nginx-internal/controller.yaml';
const internalPolicyPath =
  'infra/kubernetes/base/ingress-nginx-internal/network-policy.yaml';
const internalRoutePath =
  'infra/kubernetes/apps/backend/ingress-internal-api.yaml';

const publicSource = read(publicPath);
const internalSource = read(internalPath);
const internalPolicy = read(internalPolicyPath);
const internalRoute = read(internalRoutePath);
const backendKustomization = read(
  'infra/kubernetes/apps/backend/kustomization.yaml',
);
const baseKustomization = read('infra/kubernetes/base/kustomization.yaml');
const commonPolicies = read(
  'infra/kubernetes/base/_common/network-policies.yaml',
);
const platformRender = render('infra/kubernetes/overlays/prod');
const appsRender = render('infra/kubernetes/apps');
const platformManifests = documents(platformRender).map(manifest);
const appManifests = documents(appsRender).map(manifest);

// The only public-controller source delta is extracting nginx-internal.
assert.equal(
  behaviorLines(publicSource),
  behaviorLines(removeInternalClass(sourceAtBaseline(publicPath))),
  'public controller changed beyond nginx-internal IngressClass extraction',
);
assert.equal(
  sourceAtBaseline('infra/kubernetes/base/longhorn/longhorn-app.yaml'),
  read('infra/kubernetes/base/longhorn/longhorn-app.yaml'),
  'Longhorn public-class behavior changed',
);
assert.equal(
  sourceAtBaseline('infra/kubernetes/base/harbor/harbor-values.yaml'),
  read('infra/kubernetes/base/harbor/harbor-values.yaml'),
  'Harbor public-class behavior changed',
);

assert.match(baseKustomization, /^\s*-\s+ingress-nginx-internal\s*$/m);
assert.doesNotMatch(
  publicSource,
  /^ {2}name:\s*nginx-internal\s*$/m,
  'public source still owns nginx-internal',
);

// Exactly one public and one internal active controller use the same digest.
const ingressControllers = platformManifests.filter(
  ({ kind, document }) =>
    kind === 'DaemonSet' && document.includes('/nginx-ingress-controller'),
);
assert.equal(ingressControllers.length, 2);
assert.deepEqual(
  ingressControllers.map(({ name }) => name).sort(),
  ['ingress-nginx-controller', 'ingress-nginx-internal-controller'],
);
for (const { document } of ingressControllers) {
  assert.match(document, new RegExp(controllerDigest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(document, /--watch-ingress-without-class=false/);
}

assert.match(internalSource, /name:\s*ingress-nginx-internal-controller/);
assert.match(internalSource, /--election-id=ingress-nginx-internal-leader/);
assert.match(
  internalSource,
  /--controller-class=k8s\.io\/ingress-nginx-internal/,
);
assert.match(internalSource, /--ingress-class=nginx-internal/);
assert.match(internalSource, /--update-status=false/);
assert.doesNotMatch(internalSource, /validating-webhook|webhook-cert/);
assert.match(internalSource, /hostPort:\s*80/);
assert.match(internalSource, /hostPort:\s*443/);
assert.match(
  internalSource,
  /containerPort:\s*10254\s*\n\s*hostIP:\s*127\.0\.0\.1\s*\n\s*hostPort:\s*10255/,
);
assert.match(internalSource, /kind:\s*PodDisruptionBudget/);
assert.match(internalSource, /kind:\s*ServiceMonitor/);
assert.match(
  internalSource,
  /name:\s*nginx-internal[\s\S]*?controller:\s*k8s\.io\/ingress-nginx-internal/,
);
assert.match(
  internalSource,
  /name:\s*nginx-internal-held[\s\S]*?controller:\s*vhhealth\.io\/ingress-nginx-internal-held-unimplemented/,
);
assert.match(
  internalSource,
  /pod-security\.kubernetes\.io\/enforce:\s*privileged/,
);
assert.match(internalSource, /namespace:\s*vhhealth-ingress-internal/);

// Header and log posture trusts only the socket peer and excludes PHI-rich
// request fields.
for (const setting of [
  'use-forwarded-headers: "false"',
  'compute-full-forwarded-for: "false"',
  'use-proxy-protocol: "false"',
  'enable-real-ip: "false"',
  'allow-snippet-annotations: "false"',
  'Forwarded: ""',
  'X-Forwarded-For: "$remote_addr"',
  'X-Real-IP: ""',
  'X-Forwarded-Host: ""',
  'CF-Connecting-IP: ""',
  'True-Client-IP: ""',
  'CF-IPCountry: ""',
]) {
  assert.ok(internalSource.includes(setting), `missing internal header setting: ${setting}`);
}
const logFormat = internalSource.match(/log-format-upstream:[\s\S]*?\n---/)?.[0] || '';
assert.ok(logFormat);
for (const required of [
  '$req_id',
  '$remote_addr',
  '$host',
  '$scheme',
  '$request_method',
  '$status',
  '$bytes_sent',
  '$request_time',
]) {
  assert.ok(logFormat.includes(required), `log format missing ${required}`);
}
for (const forbidden of [
  '$uri',
  '$args',
  '$request_uri',
  '$http_authorization',
  '$http_cookie',
  '$request_body',
]) {
  assert.ok(!logFormat.includes(forbidden), `log format leaks ${forbidden}`);
}
assert.match(internalSource, /ssl-protocols:\s*"TLSv1\.2 TLSv1\.3"/);
assert.match(internalSource, /ssl-ciphers:\s*"ECDHE-/);

// The active ledger is apex-only and preserves Host/scheme.
assert.match(internalRoute, /ingressClassName:\s*nginx-internal/);
assert.equal((internalRoute.match(/^\s*-\s*host:/gm) || []).length, 1);
assert.match(internalRoute, /host:\s*api\.vhhealth\.app/);
assert.doesNotMatch(internalRoute, /\*\.vhhealth\.app/);
assert.match(internalRoute, /path:\s*\/\s*$/m);
assert.match(internalRoute, /pathType:\s*Prefix/);
assert.doesNotMatch(
  internalRoute,
  /^\s+nginx\.ingress\.kubernetes\.io\/(?:rewrite-target|upstream-vhost|proxy-set-header|configuration-snippet):/m,
);
for (const annotation of [
  'proxy-body-size: "50m"',
  'proxy-read-timeout: "60"',
  'proxy-send-timeout: "60"',
  'proxy-connect-timeout: "10"',
  'limit-connections: "50"',
  'limit-rpm: "600"',
]) {
  assert.ok(internalRoute.includes(annotation), `missing API parity: ${annotation}`);
}

assert.match(
  backendKustomization,
  /name:\s*vhhealth-internal-ingress-parameters[\s\S]*?tlsSecretName=c-d13-unprovisioned-internal-api-tls/,
);
assert.match(
  appsRender,
  /name:\s*vhhealth-backend-internal-api[\s\S]*?secretName:\s*c-d13-unprovisioned-internal-api-tls/,
);
assert.ok(
  ![...platformManifests, ...appManifests].some(
    ({ kind, name }) =>
      ['Secret', 'Certificate', 'SealedSecret'].includes(kind) &&
      name === 'c-d13-unprovisioned-internal-api-tls',
  ),
  'default render produces C-D13 TLS material',
);

// Held routes have no cert-manager or ingress-shim trigger.
const heldSources = [
  'infra/kubernetes/apps/backend/ingress-clinical-internal.yaml',
  'infra/kubernetes/apps/staff-web/ingress.yaml',
  'infra/kubernetes/base/minio/tenant.yaml',
  'infra/kubernetes/base/monitoring/kube-prometheus-values.yaml',
  'infra/kubernetes/base/argocd/argocd-values.yaml',
  'infra/kubernetes/optional/metabase/metabase.yaml',
  'infra/kubernetes/optional/pacs/ohif.yaml',
];
for (const path of heldSources) {
  const source = read(path);
  assert.match(source, /ingressClassName:\s*nginx-internal-held/);
  assert.doesNotMatch(
    source,
    /^\s+(?:cert-manager\.io\/|acme\.cert-manager\.io\/|kubernetes\.io\/tls-acme|.*ingress-shim).*:/m,
    `${path} can still request a certificate`,
  );
}

const yamlSources = walkYaml(resolve(repoRoot, 'infra/kubernetes'));
const activeClassReferences = yamlSources
  .map((path) => [relative(repoRoot, path).replaceAll('\\', '/'), readFileSync(path, 'utf8')])
  .filter(([, source]) => /^\s*ingressClassName:\s*nginx-internal\s*$/m.test(source))
  .map(([path]) => path)
  .sort();
assert.deepEqual(activeClassReferences, [
  'infra/kubernetes/apps/backend/ingress-internal-api.yaml',
  'infra/kubernetes/base/cert-manager/cert-manager.yaml',
]);

// Network policies separate cloudflared/public/internal identities.
assert.doesNotMatch(commonPolicies, /name:\s*allow-ingress-egress-all/);
assert.doesNotMatch(commonPolicies, /name:\s*allow-external-ingress/);
assert.match(commonPolicies, /name:\s*allow-cloudflared-to-public-controller/);
assert.match(
  commonPolicies,
  /name:\s*allow-cloudflared-egress[\s\S]*?app\.kubernetes\.io\/instance:\s*ingress-nginx/,
);
assert.match(internalPolicy, /name:\s*ingress-nginx-internal-default-deny/);
assert.doesNotMatch(internalPolicy, /cidr:\s*0\.0\.0\.0\/0/);
assert.match(internalPolicy, /cidr:\s*192\.0\.2\.0\/32/);
assert.match(internalPolicy, /cidr:\s*198\.51\.100\.0\/32/);
assert.match(internalPolicy, /cidr:\s*127\.0\.0\.0\/8[\s\S]*?port:\s*10254/);
assert.match(
  internalPolicy,
  /kubernetes\.io\/metadata\.name:\s*vhhealth-monitoring[\s\S]*?port:\s*10254/,
);
assert.match(
  internalPolicy,
  /app\.kubernetes\.io\/name:\s*vhhealth-backend[\s\S]*?port:\s*5000/,
);
assert.match(internalPolicy, /acme\.cert-manager\.io\/http01-solver/);

// Four parent Applications and the Longhorn child remain manual-sync.
const applications = platformManifests.filter(({ kind }) => kind === 'Application');
assert.equal(applications.length, 5);
for (const { name, document } of applications) {
  assert.match(document, /syncPolicy:/, `${name} lacks syncPolicy`);
  assert.doesNotMatch(document, /^\s*automated:\s*/m, `${name} enables automated sync`);
}
assert.ok(applications.some(({ name }) => name === 'longhorn'));

// The new internal data plane has no Service exposure or DNS automation.
const internalManifests = documents(render('infra/kubernetes/base/ingress-nginx-internal')).map(
  manifest,
);
for (const { kind, document } of internalManifests) {
  if (kind === 'Service') {
    assert.doesNotMatch(document, /type:\s*(?:LoadBalancer|NodePort)/);
  }
  assert.notEqual(kind, 'DNSEndpoint');
}
assert.doesNotMatch(platformRender, /^kind:\s*DNSEndpoint\s*$/m);

for (const inventory of [
  'infra/ansible/inventories/group_vars/all/main.yml',
  'infra/ansible/inventories/prod.yml.example',
  'infra/ansible/inventories/dev.yml',
]) {
  const source = read(inventory);
  assert.match(source, /internal_ingress_vip_enabled:\s*false/);
  assert.match(source, /internal_ingress_vip_address:\s*""/);
  assert.match(source, /internal_ingress_vip_firewall_guard_enabled:\s*false/);
}

console.log('C2.1 internal ingress contract passed.');
