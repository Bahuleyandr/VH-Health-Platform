import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { authorizeEdgeRead } from '../lib/authorization.mjs';
import { verifyPolicyReceipt } from '../lib/policy.mjs';
import {
  FACILITY_ID,
  TENANT_ID,
  buildMirror,
  createTestRuntime,
} from './helpers/fixture.mjs';

let runtime;
const roots = [];
const grant = {
  accessRevision: '11',
  clientCertificateSha256: 'a'.repeat(64),
  deviceId: 'terminal-ward-10',
  grantId: '11111111-1111-4111-8111-111111111111',
  locationIdentifier: 'ward-10',
  locationType: 'ward',
  staffUid: '22222222-2222-4222-8222-222222222222',
  validFrom: '2026-07-30T00:00:00.000Z',
  validUntil: '2026-07-30T00:30:00.000Z',
};

before(async () => {
  runtime = await createTestRuntime();
});

after(async () => {
  await Promise.all([
    ...roots.map((root) => rm(root, { recursive: true, force: true })),
    runtime ? rm(runtime.root, { recursive: true, force: true }) : Promise.resolve(),
  ]);
});

async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vh-edge-auth-'));
  roots.push(root);
  return buildMirror({
    runtime,
    root,
    edgeGrants: [grant],
    ...overrides,
  });
}

function policy(fixture) {
  return verifyPolicyReceipt(fixture.policyReceipt, {
    policyKeys: fixture.trustedKeys.policyKeys,
    manifestEnvelope: fixture.manifestEnvelope,
    scope: { tenantId: TENANT_ID, facilityId: FACILITY_ID },
    trustedNow: fixture.trustedNow,
    floors: fixture.floors,
    canonical: runtime.canonical,
  });
}

function authorize(fixture, trustedNow = fixture.trustedNow) {
  return authorizeEdgeRead({
    edgeAccessEnvelope: fixture.edgeEnvelope,
    policy: policy(fixture),
    floors: fixture.floors,
    scope: { tenantId: TENANT_ID, facilityId: FACILITY_ID },
    location: {
      tenantId: TENANT_ID,
      facilityId: FACILITY_ID,
      locationType: 'ward',
      locationIdentifier: 'ward-10',
      asset: 'pack.html',
    },
    staffUid: grant.staffUid,
    deviceId: grant.deviceId,
    clientCertificateSha256: grant.clientCertificateSha256,
    trustedNow,
  });
}

test('authorizes exactly one audience-, device-, certificate-, and location-bound grant', async () => {
  const built = await fixture();
  assert.equal(authorize(built).grantId, grant.grantId);
});

test('rejects an expired or signed-revoked credential without fallback access', async () => {
  const expired = await fixture();
  assert.throws(
    () => authorize(expired, '2026-07-30T00:31:00.000Z'),
    /ACCESS_GRANT_NOT_AUTHORIZED/,
  );

  const revoked = await fixture({
    edgeRevocations: [
      {
        accessRevision: '11',
        grantId: grant.grantId,
        revokedAt: '2026-07-30T00:00:30.000Z',
      },
    ],
  });
  assert.throws(
    () => authorize(revoked),
    /ACCESS_GRANT_NOT_AUTHORIZED/,
  );
});
