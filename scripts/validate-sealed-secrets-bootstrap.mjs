import { readFileSync } from 'node:fs';
import process from 'node:process';

function fail(message) {
  throw new Error(`invalid Sealed Secrets bootstrap render: ${message}`);
}

function unquote(value) {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function topLevelScalar(document, key) {
  const match = document.match(new RegExp(`^${key}:\\s*([^#\\r\\n]+?)\\s*$`, 'm'));
  return match ? unquote(match[1]) : null;
}

function metadataScalar(document, key) {
  const metadata = document.match(/^metadata:\s*\r?\n((?:[ \t]+.*(?:\r?\n|$))*)/m)?.[1] ?? '';
  const match = metadata.match(new RegExp(`^  ${key}:\\s*([^#\\r\\n]+?)\\s*$`, 'm'));
  return match ? unquote(match[1]) : null;
}

function identity(document) {
  const kind = topLevelScalar(document, 'kind');
  const name = metadataScalar(document, 'name');
  const namespace = metadataScalar(document, 'namespace');
  if (!kind || !name) fail('every document must have kind and metadata.name');
  return `${kind}/${namespace ? `${namespace}/` : ''}${name}`;
}

const expectedIdentities = [
  'Namespace/vhhealth-security',
  'CustomResourceDefinition/sealedsecrets.bitnami.com',
  'ServiceAccount/vhhealth-security/sealed-secrets',
  'Service/vhhealth-security/sealed-secrets',
  'ClusterRole/sealed-secrets',
  'ClusterRoleBinding/sealed-secrets',
  'Deployment/vhhealth-security/sealed-secrets',
];

export function validateBootstrap(rendered) {
  const documents = rendered
    .split(/^---\s*$/m)
    .map(document => document.trim())
    .filter(Boolean);
  const identities = documents.map(identity);

  for (const document of documents) {
    const apiVersion = topLevelScalar(document, 'apiVersion');
    const kind = topLevelScalar(document, 'kind');
    if (apiVersion?.startsWith('monitoring.coreos.com/') || kind === 'ServiceMonitor') {
      fail('monitoring CRs must be installed by the monitoring Kustomization, not bootstrap');
    }
  }

  if (documents.length !== expectedIdentities.length) {
    fail(
      `expected exactly ${expectedIdentities.length} bootstrap resources, ` +
        `found ${documents.length}: ${identities.join(', ')}`,
    );
  }

  for (const expected of expectedIdentities) {
    const count = identities.filter(actual => actual === expected).length;
    if (count !== 1) fail(`expected exactly one ${expected}, found ${count}`);
  }

  const unexpected = identities.filter(actual => !expectedIdentities.includes(actual));
  if (unexpected.length > 0) fail(`unexpected resources: ${unexpected.join(', ')}`);

  const namespace = documents[identities.indexOf('Namespace/vhhealth-security')];
  for (const mode of ['enforce', 'audit', 'warn']) {
    const pattern = new RegExp(`pod-security\\.kubernetes\\.io/${mode}:\\s*restricted(?:\\s|$)`);
    if (!pattern.test(namespace)) fail(`Namespace must set Pod Security ${mode}=restricted`);
  }

  const binding = documents[identities.indexOf('ClusterRoleBinding/sealed-secrets')];
  if (
    !/roleRef:\s*\r?\n\s{2}apiGroup:\s*rbac\.authorization\.k8s\.io\s*\r?\n\s{2}kind:\s*ClusterRole\s*\r?\n\s{2}name:\s*sealed-secrets\s*(?:\r?\n|$)/m.test(binding)
  ) {
    fail('ClusterRoleBinding roleRef must be ClusterRole/sealed-secrets');
  }
  const subjects = binding.match(/subjects:\s*\r?\n([\s\S]*)$/m)?.[1] ?? '';
  const subjectKinds = subjects.match(/^\s*-\s*kind:/gm) ?? [];
  if (
    subjectKinds.length !== 1 ||
    !/^\s*-\s*kind:\s*ServiceAccount\s*\r?\n\s*name:\s*sealed-secrets\s*\r?\n\s*namespace:\s*vhhealth-security\s*(?:\r?\n|$)/m.test(subjects)
  ) {
    fail('ClusterRoleBinding must bind only vhhealth-security/sealed-secrets');
  }

  const deployment = documents[identities.indexOf('Deployment/vhhealth-security/sealed-secrets')];
  if (!/^\s{6}serviceAccountName:\s*sealed-secrets\s*$/m.test(deployment)) {
    fail('Deployment must use ServiceAccount sealed-secrets');
  }
  if (!/^\s{8}name:\s*sealed-secrets\s*$/m.test(deployment)) {
    fail('Deployment must contain the sealed-secrets controller container');
  }
  if (!/^\s{8}command:\s*\r?\n\s{8}-\s*controller\s*$/m.test(deployment)) {
    fail('Deployment controller container must execute the sealed-secrets controller');
  }
  for (const argument of [
    '--key-renew-period=720h',
    '--key-prefix=sealed-secrets-key',
    '--log-level=INFO',
    '--log-format=json',
    '--listen-addr=:8080',
    '--listen-metrics-addr=:8081',
  ]) {
    if (!new RegExp(`^\\s*- ${argument.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm').test(deployment)) {
      fail(`Deployment controller args must include ${argument}`);
    }
  }
  for (const invalid of [
    '--key-cutoff-time=0',
    '--listen-address=',
    '--listen-metrics-address=',
  ]) {
    if (deployment.includes(invalid)) fail(`Deployment controller args must not include ${invalid}`);
  }
}

if (process.argv[1] && new URL(import.meta.url).pathname.endsWith(process.argv[1].replaceAll('\\', '/'))) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/validate-sealed-secrets-bootstrap.mjs <rendered.yaml>');
    process.exit(2);
  }

  try {
    validateBootstrap(readFileSync(process.argv[2], 'utf8'));
    console.log('Sealed Secrets bootstrap render has the exact fresh-cluster-safe identity.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
