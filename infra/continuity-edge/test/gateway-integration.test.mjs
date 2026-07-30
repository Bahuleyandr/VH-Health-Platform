import assert from 'node:assert/strict';
import {
  X509Certificate,
} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createGateway } from '../lib/gateway.mjs';
import {
  FACILITY_ID,
  POLICY_ID,
  TENANT_ID,
  TRUSTED_NOW,
  buildMirror,
  createTestRuntime,
} from './helpers/fixture.mjs';
import {
  installTestPrivateKey,
  testCertificatePath,
} from './helpers/test-identity.mjs';

let runtime;
const roots = [];
let privateKeyPath;

before(async () => {
  runtime = await createTestRuntime();
  const keyRoot = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-test-key-'));
  roots.push(keyRoot);
  privateKeyPath = await installTestPrivateKey(keyRoot);
});

after(async () => {
  await Promise.all([
    ...roots.map((root) => rm(root, { recursive: true, force: true })),
    runtime ? rm(runtime.root, { recursive: true, force: true }) : Promise.resolve(),
  ]);
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function request({ port, headers }) {
  const [key, cert] = await Promise.all([
    readFile(privateKeyPath),
    readFile(testCertificatePath),
  ]);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path:
          `/v1/tenants/${TENANT_ID}/facilities/${FACILITY_ID}` +
          '/locations/ward/ward-10/pack.html',
        method: 'GET',
        key,
        cert,
        ca: cert,
        checkServerIdentity: () => undefined,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('mTLS gateway serves only an exact authorized path and seals the read first', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-gateway-'));
  roots.push(root);
  const certificatePem = await readFile(testCertificatePath, 'utf8');
  const fingerprint = new X509Certificate(certificatePem).fingerprint256
    .replaceAll(':', '')
    .toLowerCase();
  const terminalGrant = {
    accessRevision: '11',
    clientCertificateSha256: fingerprint,
    deviceId: 'terminal-ward-10',
    grantId: '11111111-1111-4111-8111-111111111111',
    locationIdentifier: 'ward-10',
    locationType: 'ward',
    staffUid: '22222222-2222-4222-8222-222222222222',
    validFrom: '2026-07-30T00:00:00.000Z',
    validUntil: '2026-07-30T00:30:00.000Z',
  };
  const loggingGrant = {
    accessRevision: '11',
    clientCertificateSha256: fingerprint,
    deviceId: 'edge-logger-ward-10',
    grantId: '33333333-3333-4333-8333-333333333333',
    locationIdentifier: 'ward-10',
    locationType: 'ward',
    staffUid: '44444444-4444-4444-8444-444444444444',
    validFrom: '2026-07-30T00:00:00.000Z',
    validUntil: '2026-07-30T00:30:00.000Z',
  };
  const fixture = await buildMirror({
    runtime,
    root,
    edgeGrants: [terminalGrant, loggingGrant],
  });
  const configRoot = path.join(root, 'config');
  const stateRoot = path.join(root, 'state');
  const logRoot = path.join(root, 'logs');
  await Promise.all([
    mkdir(configRoot, { recursive: true }),
    mkdir(stateRoot, { recursive: true }),
    mkdir(logRoot, { recursive: true }),
  ]);
  const pointer = JSON.parse(
    await readFile(fixture.receipt.paths.currentPath, 'utf8'),
  );
  const trustedKeysPath = path.join(configRoot, 'trusted-keys.json');
  const policyReceiptPath = path.join(configRoot, 'policy.json');
  const floorsPath = path.join(stateRoot, 'floors.json');
  const loggingIdentitiesPath = path.join(configRoot, 'logging.json');
  await Promise.all([
    writeFile(trustedKeysPath, JSON.stringify(fixture.trustedKeys)),
    writeFile(policyReceiptPath, JSON.stringify(fixture.policyReceipt)),
    writeFile(
      floorsPath,
      JSON.stringify({
        format: 'vhhealth_continuity_edge_floors/v1',
        ...fixture.floors,
        manifestVersion: '8',
        policyVersion: '6',
        revocationEpoch: '2',
        accessRevision: '10',
        trustedNow: '2026-07-29T23:59:00.000Z',
        currentManifestSha256: '0'.repeat(64),
        updatedAt: '2026-07-29T23:59:00.000Z',
      }),
    ),
    writeFile(
      loggingIdentitiesPath,
      JSON.stringify({
        format: 'vhhealth_continuity_edge_logging_identities/v1',
        locations: {
          'ward/ward-10': {
            accessRevision: '11',
            certificatePath: testCertificatePath,
            deviceId: loggingGrant.deviceId,
            facilityId: FACILITY_ID,
            grantId: loggingGrant.grantId,
            locationIdentifier: 'ward-10',
            locationType: 'ward',
            policyVersion: '7',
            policyVersionId: POLICY_ID,
            privateKeyPath,
            tenantId: TENANT_ID,
          },
        },
      }),
    ),
  ]);

  const caddy = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>edge</title>');
  });
  const caddyPort = await listen(caddy);
  const gateway = createGateway({
    config: {
      scope: { tenantId: TENANT_ID, facilityId: FACILITY_ID },
      dataRoot: root,
      logRoot,
      trustedKeysPath,
      policyReceiptPath,
      floorsPath,
      bootstrapFloorsPath: path.join(configRoot, 'unused-bootstrap.json'),
      prometheusPath: path.join(stateRoot, 'metrics.prom'),
      gateway: {
        caddyOrigin: `http://127.0.0.1:${caddyPort}`,
        loggingIdentitiesPath,
      },
    },
    runtime,
    now: () => new Date(TRUSTED_NOW),
  });
  gateway.setSecureContext({
    key: await readFile(privateKeyPath),
    cert: await readFile(testCertificatePath),
    ca: await readFile(testCertificatePath),
    minVersion: 'TLSv1.2',
  });
  const gatewayPort = await listen(gateway);

  try {
    const denied = await request({
      port: gatewayPort,
      headers: {
        'X-VHHealth-Staff-Uid': '55555555-5555-4555-8555-555555555555',
        'X-VHHealth-Device-Id': terminalGrant.deviceId,
      },
    });
    assert.equal(denied.status, 403);
    const recoveredFloors = JSON.parse(await readFile(floorsPath, 'utf8'));
    assert.equal(recoveredFloors.manifestVersion, '9');
    assert.equal(recoveredFloors.policyVersion, '7');
    assert.equal(recoveredFloors.revocationEpoch, '3');
    assert.equal(recoveredFloors.accessRevision, '11');
    assert.equal(recoveredFloors.currentManifestSha256, pointer.manifest_sha256);
    assert.equal(recoveredFloors.trustedNow, TRUSTED_NOW);

    const authorized = await request({
      port: gatewayPort,
      headers: {
        'X-VHHealth-Staff-Uid': terminalGrant.staffUid,
        'X-VHHealth-Device-Id': terminalGrant.deviceId,
      },
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.body, '<!doctype html><title>edge</title>');

    const completedRoots = await readdir(
      path.join(logRoot, 'completed'),
      { recursive: true },
    );
    const completedFiles = completedRoots.filter((entry) =>
      String(entry).endsWith('.json'),
    );
    assert.equal(completedFiles.length, 2);
    const outcomes = [];
    for (const relativeFile of completedFiles) {
      const envelope = JSON.parse(
        await readFile(path.join(logRoot, 'completed', relativeFile), 'utf8'),
      );
      outcomes.push(...envelope.content.events.map((event) => event.outcome));
    }
    assert.deepEqual(outcomes.sort(), ['authorized', 'denied']);
  } finally {
    await Promise.all([
      new Promise((resolve) => gateway.close(resolve)),
      new Promise((resolve) => caddy.close(resolve)),
    ]);
  }
});
