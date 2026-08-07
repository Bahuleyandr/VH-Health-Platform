#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const tenantId = '00000000-0000-4000-8000-000000000001';

function read(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8').replace(/\r\n/g, '\n');
}

function documents(text) {
  return text
    .split(/\n---\s*\n/)
    .map(document => document.trim())
    .filter(Boolean);
}

function metadataValue(document, key) {
  const match = document.match(
    new RegExp(
      `^metadata:\\s*\\n(?:(?: {2}.*)?\\n)*? {2}${key}:\\s*["']?([^"'#\\n]+)`,
      'm',
    ),
  );
  return match?.[1]?.trim();
}

function kind(document) {
  return document.match(/^kind:\s*["']?([^"'#\n]+)/m)?.[1]?.trim();
}

function configMap(source, namespace, name) {
  const matches = documents(source).filter(
    document =>
      kind(document) === 'ConfigMap' &&
      metadataValue(document, 'namespace') === namespace &&
      metadataValue(document, 'name') === name,
  );
  assert.equal(
    matches.length,
    1,
    `expected one ConfigMap ${namespace}/${name}`,
  );
  return matches[0];
}

function dataValue(document, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.match(
    new RegExp(`^ {2}${escaped}:\\s*["']?([^"'#\\n]+)`, 'm'),
  );
  return match?.[1]?.trim();
}

function routeHeaderCount(source) {
  return source.match(/^ {2}X-VH-Route-Kind:/gm)?.length ?? 0;
}

function applyProxySetHeaders(callerHeaders, configuredHeaders) {
  const forwarded = new Map(
    Object.entries(callerHeaders).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  for (const [name, value] of Object.entries(configuredHeaders)) {
    forwarded.set(name.toLowerCase(), value);
  }
  return forwarded;
}

const publicSource = read(
  'infra/kubernetes/base/ingress-nginx/ingress-nginx.yaml',
);
const internalSource = read(
  'infra/kubernetes/base/ingress-nginx-internal/controller.yaml',
);

const publicController = configMap(
  publicSource,
  'vhhealth-ingress',
  'ingress-nginx-controller',
);
const publicHeaders = configMap(
  publicSource,
  'vhhealth-ingress',
  'nginx-security-headers',
);
const internalController = configMap(
  internalSource,
  'vhhealth-ingress-internal',
  'ingress-nginx-internal-controller',
);
const internalHeaders = configMap(
  internalSource,
  'vhhealth-ingress-internal',
  'ingress-nginx-internal-request-headers',
);

assert.equal(
  dataValue(publicController, 'proxy-set-headers'),
  'vhhealth-ingress/nginx-security-headers',
);
assert.equal(
  dataValue(internalController, 'proxy-set-headers'),
  'vhhealth-ingress-internal/ingress-nginx-internal-request-headers',
);
assert.equal(dataValue(publicController, 'use-forwarded-headers'), 'true');
assert.equal(dataValue(publicController, 'compute-full-forwarded-for'), 'false');
assert.equal(dataValue(publicController, 'use-proxy-protocol'), 'false');
assert.equal(dataValue(publicController, 'enable-real-ip'), 'true');
assert.equal(
  dataValue(publicController, 'forwarded-for-header'),
  'CF-Connecting-IP',
);
assert.equal(dataValue(publicHeaders, 'X-VH-Route-Kind'), 'public');
assert.equal(dataValue(internalHeaders, 'X-VH-Route-Kind'), 'internal');
assert.equal(routeHeaderCount(publicSource), 1);
assert.equal(routeHeaderCount(internalSource), 1);

for (const callerValue of [
  undefined,
  'public',
  'internal',
  'caller-supplied',
]) {
  const callerHeaders =
    callerValue === undefined ? {} : { 'X-VH-Route-Kind': callerValue };
  const publicForwarded = applyProxySetHeaders(callerHeaders, {
    'X-VH-Route-Kind': dataValue(publicHeaders, 'X-VH-Route-Kind'),
  });
  const internalForwarded = applyProxySetHeaders(callerHeaders, {
    'X-VH-Route-Kind': dataValue(internalHeaders, 'X-VH-Route-Kind'),
  });
  assert.equal(publicForwarded.get('x-vh-route-kind'), 'public');
  assert.equal(internalForwarded.get('x-vh-route-kind'), 'internal');
}

process.env.DATABASE_URL ??=
  'postgresql://c2_2_contract@127.0.0.1:1/c2_2_contract';
process.env.DATABASE_READ_URL ??= process.env.DATABASE_URL;
const { evaluateClientReadiness } = await import(
  '../../../apps/backend/src/services/health/clientReadinessService.js'
);

let databaseProbeCount = 0;
for (const routeKind of [undefined, '', 'caller-supplied', 'unknown']) {
  const result = await evaluateClientReadiness({
    tenantId,
    routeKind,
    loadPolicies: async () => {
      databaseProbeCount += 1;
      throw new Error('untrusted route kind reached the database');
    },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.ready, false);
  assert.equal(result.payload.state, 'endpoint_unverified');
  assert.equal(Object.hasOwn(result.payload, 'routeKind'), false);
}
assert.equal(databaseProbeCount, 0);

console.log(
  'C2.2 route-kind contract passed: controller headers overwrite caller input, and untrusted markers fail closed before database access.',
);
