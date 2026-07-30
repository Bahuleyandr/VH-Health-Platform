import assert from 'node:assert/strict';
import {
  access,
  mkdtemp,
  readFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { verifyPolicyReceipt } from '../lib/policy.mjs';
import { purgeObsoleteSets } from '../lib/purge.mjs';
import {
  FACILITY_ID,
  TENANT_ID,
  buildMirror,
  createTestRuntime,
  facilityDirectory,
  newSigningKeys,
} from './helpers/fixture.mjs';

let runtime;
const roots = [];

before(async () => {
  runtime = await createTestRuntime();
});

after(async () => {
  await Promise.all([
    ...roots.map((root) => rm(root, { recursive: true, force: true })),
    runtime ? rm(runtime.root, { recursive: true, force: true }) : Promise.resolve(),
  ]);
});

async function root() {
  const created = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-purge-'));
  roots.push(created);
  return created;
}

function policyOptions(fixture) {
  return {
    policyKeys: fixture.trustedKeys.policyKeys,
    manifestEnvelope: fixture.manifestEnvelope,
    scope: { tenantId: TENANT_ID, facilityId: FACILITY_ID },
    trustedNow: fixture.trustedNow,
    floors: fixture.floors,
    canonical: runtime.canonical,
  };
}

test('missing, unsigned, and modified retention decisions never authorize purge', async () => {
  const fixture = await buildMirror({ runtime, root: await root() });
  assert.throws(
    () => verifyPolicyReceipt(undefined, policyOptions(fixture)),
    /SIGNED_POLICY_INVALID/,
  );
  const unsigned = structuredClone(fixture.policyReceipt);
  unsigned.signature = `${unsigned.signature[0] === 'A' ? 'B' : 'A'}${unsigned.signature.slice(1)}`;
  assert.throws(
    () => verifyPolicyReceipt(unsigned, policyOptions(fixture)),
    /SIGNED_POLICY_SIGNATURE_INVALID/,
  );
  const modified = structuredClone(fixture.policyReceipt);
  modified.payload.policyDocument.retention.edgePackRetentionHours = 1;
  assert.throws(
    () => verifyPolicyReceipt(modified, policyOptions(fixture)),
    /SIGNED_POLICY_SIGNATURE_INVALID/,
  );
});

test('purges only a verified obsolete set and never the selected current set', async () => {
  const mirrorRoot = await root();
  const signingKeys = newSigningKeys();
  await buildMirror({
    runtime,
    root: mirrorRoot,
    signingKeys,
    manifestVersion: '8',
    issuedAt: '2026-07-29T08:00:00.000Z',
    expiresAt: '2026-07-29T12:00:00.000Z',
  });
  const current = await buildMirror({
    runtime,
    root: mirrorRoot,
    signingKeys,
    manifestVersion: '9',
  });
  const policy = verifyPolicyReceipt(
    current.policyReceipt,
    policyOptions(current),
  );
  const removed = await purgeObsoleteSets({
    dataRoot: mirrorRoot,
    scope: { tenantId: TENANT_ID, facilityId: FACILITY_ID },
    trustedKeys: current.trustedKeys,
    runtime,
    policy,
    now: new Date('2026-07-30T01:00:00.000Z'),
  });
  assert.deepEqual(removed, ['v8']);
  await assert.rejects(
    access(path.join(facilityDirectory(mirrorRoot), 'sets', 'v8')),
    /ENOENT/,
  );
  await access(path.join(facilityDirectory(mirrorRoot), 'sets', 'v9'));
  const pointer = JSON.parse(
    await readFile(
      path.join(facilityDirectory(mirrorRoot), 'current.json'),
      'utf8',
    ),
  );
  assert.equal(pointer.manifest_version, '9');

  assert.deepEqual(
    await purgeObsoleteSets({
      dataRoot: mirrorRoot,
      scope: { tenantId: TENANT_ID, facilityId: FACILITY_ID },
      trustedKeys: current.trustedKeys,
      runtime,
      policy,
      now: new Date('2026-08-30T01:00:00.000Z'),
    }),
    [],
  );
  await access(path.join(facilityDirectory(mirrorRoot), 'sets', 'v9'));
});
