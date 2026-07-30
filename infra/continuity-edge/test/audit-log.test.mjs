import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  appendAuditEvent,
  pathsForLoggingIdentity,
  sealAuditBatch,
  verifyActiveJournal,
  verifyBatchEnvelope,
  verifyCompletedBatchChain,
  verifyLoggingIdentityMaterial,
} from '../lib/audit-log.mjs';
import {
  FACILITY_ID,
  POLICY_ID,
  TENANT_ID,
  createTestRuntime,
} from './helpers/fixture.mjs';
import {
  installTestPrivateKey,
  testCertificatePath,
} from './helpers/test-identity.mjs';

let runtime;
let privateKeyPath;
const roots = [];
let identity;

before(async () => {
  runtime = await createTestRuntime();
  const keyRoot = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-test-key-'));
  roots.push(keyRoot);
  privateKeyPath = await installTestPrivateKey(keyRoot);
  identity = {
    tenantId: TENANT_ID,
    facilityId: FACILITY_ID,
    locationType: 'ward',
    locationIdentifier: 'ward-10',
    deviceId: 'edge-logger-ward-10',
    grantId: '11111111-1111-4111-8111-111111111111',
    policyVersionId: POLICY_ID,
    policyVersion: '7',
    accessRevision: '11',
    certificatePath: testCertificatePath,
    privateKeyPath,
  };
});

after(async () => {
  await Promise.all([
    ...roots.map((root) => rm(root, { recursive: true, force: true })),
    runtime ? rm(runtime.root, { recursive: true, force: true }) : Promise.resolve(),
  ]);
});

async function logRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-audit-'));
  roots.push(root);
  return root;
}

async function event(sequence) {
  const certificate = new X509Certificate(
    await readFile(testCertificatePath, 'utf8'),
  );
  return {
    occurredAt: new Date(
      Date.parse('2026-07-30T00:00:00.000Z') + sequence * 1000,
    ).toISOString(),
    staffUid: '22222222-2222-4222-8222-222222222222',
    deviceId: 'terminal-ward-10',
    clientCertificateSha256: certificate.fingerprint256
      .replaceAll(':', '')
      .toLowerCase(),
    accessGrantId: '33333333-3333-4333-8333-333333333333',
    method: sequence % 2 === 0 ? 'HEAD' : 'GET',
    asset: sequence % 2 === 0 ? 'pack.json' : 'pack.html',
    outcome: 'authorized',
  };
}

test('seals Ed25519 batches that preserve the exact central ingest envelope', async () => {
  const root = await logRoot();
  assert.match(
    (await verifyLoggingIdentityMaterial(identity)).certificateSha256,
    /^[0-9a-f]{64}$/,
  );
  await appendAuditEvent({
    logRoot: root,
    identity,
    event: await event(1),
    canonical: runtime.canonical,
  });
  await appendAuditEvent({
    logRoot: root,
    identity,
    event: await event(2),
    canonical: runtime.canonical,
  });
  const sealed = await sealAuditBatch({
    logRoot: root,
    identity,
    canonical: runtime.canonical,
  });
  const verified = await verifyBatchEnvelope(sealed.envelope, {
    identity,
    canonical: runtime.canonical,
    certificatePem: await readFile(testCertificatePath, 'utf8'),
  });
  assert.equal(verified.ok, true);
  assert.deepEqual(Object.keys(sealed.envelope).sort(), [
    'algorithm',
    'content',
    'contentHash',
    'keyFingerprint',
    'signature',
  ]);
  assert.equal(sealed.envelope.content.events.length, 2);
});

test('detects journal truncation, rewrites, and event hash manipulation', async () => {
  const root = await logRoot();
  await appendAuditEvent({
    logRoot: root,
    identity,
    event: await event(1),
    canonical: runtime.canonical,
  });
  const paths = pathsForLoggingIdentity(root, identity);
  const original = await readFile(paths.active, 'utf8');
  await writeFile(paths.active, original.slice(0, -2));
  await assert.rejects(
    verifyActiveJournal(root, identity, runtime.canonical),
    /AUDIT_LOG_TRUNCATED_OR_REWRITTEN/,
  );

  await writeFile(paths.active, original);
  const parsed = JSON.parse(original);
  parsed.asset = 'pack.json';
  await writeFile(paths.active, `${JSON.stringify(parsed)}\n`);
  await assert.rejects(
    verifyActiveJournal(root, identity, runtime.canonical),
    /AUDIT_LOG_HASH_CHAIN_GAP/,
  );
});

test('detects a dropped completed batch by previous hash and event sequence', async () => {
  const root = await logRoot();
  const sealed = [];
  for (let index = 1; index <= 3; index += 1) {
    await appendAuditEvent({
      logRoot: root,
      identity,
      event: await event(index),
      canonical: runtime.canonical,
    });
    sealed.push(
      await sealAuditBatch({
        logRoot: root,
        identity,
        canonical: runtime.canonical,
      }),
    );
  }
  assert.equal(
    (await verifyCompletedBatchChain(root, identity, runtime.canonical)).length,
    3,
  );
  await unlink(sealed[1].completed);
  await assert.rejects(
    verifyCompletedBatchChain(root, identity, runtime.canonical),
    /AUDIT_BATCH_CHAIN_GAP/,
  );
});
