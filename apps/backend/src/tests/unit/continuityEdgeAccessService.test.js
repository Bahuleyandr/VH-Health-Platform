import { createHash, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: jest.fn(),
}));

const {
  CONTINUITY_EDGE_LOG_BATCH_FORMAT,
  authorizeContinuityEdgeCredential,
  buildContinuityEdgeGrantSet,
  createContinuityEdgeGrant,
  fingerprintContinuityEdgeCertificate,
  ingestContinuityEdgeLogBatch
} = await import('../../services/downtime/continuityEdgeAccessService.js');
import {
  hashCanonicalValue,
  signCanonicalValue
} from '../../services/downtime/continuityPackCanonical.js';

const TENANT = '52e31913-c846-4458-a21b-31cd2f457e9b';
const FACILITY = 41;
const POLICY_ID = '55555555-5555-4555-8555-555555555555';
const STAFF = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const GRANT_ID = '44444444-4444-4444-8444-444444444444';

const TEST_CERTIFICATE = Buffer.from(
  'MIIBUzCCAQWgAwIBAgIUPxNPkp0vEu3HdVsyAhP9Wy7G6bowBQYDK2VwMB8xHTAb'
    + 'BgNVBAMMFGNvbnRpbnVpdHktZWRnZS10ZXN0MB4XDTI2MDczMDAwNDkzNFoXDTM2'
    + 'MDcyNzAwNDkzNFowHzEdMBsGA1UEAwwUY29udGludWl0eS1lZGdlLXRlc3QwKjAF'
    + 'BgMrZXADIQBH/vkx+QS4vF7/DJOBdrXv+riv9wIpOg6aF58S3Y14naNTMFEwHQYD'
    + 'VR0OBBYEFNVBm4nW9pjt/RO0DcjYTS4/lFRFMB8GA1UdIwQYMBaAFNVBm4nW9pjt'
    + '/RO0DcjYTS4/lFRFMA8GA1UdEwEB/wQFMAMBAf8wBQYDK2VwA0EA3wtCAmASPPLK'
    + 'pbLAcBtYbTk1U3vDHBxVxxNY/mX5Ftr2Ri1LQCOyGGXpV9vSd/1Q0IpJATye3LIP'
    + 'WcOiUYb+AA==',
  'base64'
);

const TEST_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    'MC4CAQAwBQYDK2VwBCIEIKLoXC5CoW1VxFbWZBjW8Gt6HEmeYCIDgYNkC/trSpMr',
    'base64'
  ),
  format: 'der',
  type: 'pkcs8'
});

function scopeRunner(tx) {
  return async (_tenantId, callback) => callback(tx);
}

function policy() {
  return {
    id: POLICY_ID,
    tenantId: TENANT,
    facilityId: FACILITY,
    policyVersion: '12',
    policySchemaVersion: 2,
    revocationEpoch: '4',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    effectiveUntil: '2026-09-01T00:00:00.000Z',
    trustedNow: '2026-07-30T00:00:00.000Z',
    policyDocument: {
      policySchemaVersion: 2,
      requiredCoverage: {
        wards: [{ wardId: 10, locationIdentifier: 'ward-10' }],
        paediatricWards: [],
        edBoards: [],
        opdClinicDays: []
      }
    }
  };
}

function edgeDecisions() {
  return {
    edgeAccess: {
      authenticationMode: 'mtls_client_certificate',
      credentialLifetimeMinutes: 480,
      emergencyReadPosture: 'read_only',
      maximumOfflineAuthorizationMinutes: 60
    },
    retention: {
      accessLogRetentionHours: 720,
      edgePackRetentionHours: 48,
      sourcePackRetentionHours: 72
    }
  };
}

function grantInput(overrides = {}) {
  return {
    tenantId: TENANT,
    facilityId: FACILITY,
    locationType: 'ward',
    locationIdentifier: 'ward-10',
    staffUid: STAFF,
    deviceId: 'edge-device-01',
    certificatePem: TEST_CERTIFICATE,
    validFrom: '2026-07-30T01:00:00.000Z',
    validUntil: '2026-07-30T04:00:00.000Z',
    policyVersionId: POLICY_ID,
    policyVersion: '12',
    createdBy: ACTOR,
    ...overrides
  };
}

describe('continuity edge access service', () => {
  test('fingerprints an operator-supplied public certificate', () => {
    expect(fingerprintContinuityEdgeCertificate(TEST_CERTIFICATE)).toMatch(
      /^[0-9a-f]{64}$/
    );
    expect(() => fingerprintContinuityEdgeCertificate(TEST_PRIVATE_KEY)).toThrow(
      'public X.509'
    );
  });

  test('creates a grant without accepting an operator-supplied revision', async () => {
    const query = jest.fn(async (sql, ...params) => {
      expect(sql).toContain('INSERT INTO clinical_continuity_edge_access_grants');
      expect(sql).not.toContain('access_revision,');
      expect(params[6]).toBe(fingerprintContinuityEdgeCertificate(TEST_CERTIFICATE));
      return [{
        id: GRANT_ID,
        tenant_id: TENANT,
        facility_id: FACILITY,
        access_revision: '21'
      }];
    });
    const result = await createContinuityEdgeGrant(grantInput(), {
      scopeRunner: scopeRunner({ $queryRawUnsafe: query }),
      policyLoader: async () => policy(),
      edgePolicyRequirement: () => edgeDecisions()
    });

    expect(result).toMatchObject({ id: GRANT_ID, access_revision: '21' });
    expect(query).toHaveBeenCalledTimes(1);
  });

  test('fails closed when grant lifetime exceeds the signed value', async () => {
    await expect(
      createContinuityEdgeGrant(
        grantInput({ validUntil: '2026-07-31T00:00:00.000Z' }),
        {
          scopeRunner: scopeRunner({ $queryRawUnsafe: jest.fn() }),
          policyLoader: async () => policy(),
          edgePolicyRequirement: () => edgeDecisions()
        }
      )
    ).rejects.toMatchObject({
      code: 'CONTINUITY_EDGE_CREDENTIAL_LIFETIME_EXCEEDED'
    });
  });

  test('fails closed when grant validity starts before the public certificate', async () => {
    await expect(
      createContinuityEdgeGrant(
        grantInput({ validFrom: '2026-07-30T00:00:00.000Z' }),
        {
          scopeRunner: scopeRunner({ $queryRawUnsafe: jest.fn() }),
          policyLoader: async () => policy(),
          edgePolicyRequirement: () => edgeDecisions()
        }
      )
    ).rejects.toMatchObject({
      code: 'CONTINUITY_EDGE_CERTIFICATE_TIME_MISMATCH'
    });
  });

  test('exports grants and revocations under one facility access revision', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: GRANT_ID,
          location_type: 'ward',
          location_identifier: 'ward-10',
          staff_uid: STAFF,
          device_id: 'edge-device-01',
          client_certificate_sha256: 'a'.repeat(64),
          valid_from: '2026-07-30T00:00:00.000Z',
          valid_until: '2026-07-30T04:00:00.000Z',
          access_revision: '21',
          revocation_access_revision: '23',
          revoked_at: '2026-07-30T02:00:00.000Z'
        }
      ])
      .mockResolvedValueOnce([{ access_revision: '23' }]);
    const grantSet = await buildContinuityEdgeGrantSet({
      tx: { $queryRawUnsafe: query },
      policy: policy(),
      edgePolicyRequirement: () => edgeDecisions()
    });

    expect(grantSet.accessRevision).toBe('23');
    expect(grantSet.grants).toHaveLength(1);
    expect(grantSet.revocations).toEqual([
      {
        accessRevision: '23',
        grantId: GRANT_ID,
        revokedAt: '2026-07-30T02:00:00.000Z'
      }
    ]);
    const canonicalMainFixture = fs.readFileSync(
      new URL('../fixtures/continuity-edge-main-e5aa113cb.json', import.meta.url),
      'utf8'
    ).trim();
    const canonicalCurrent = JSON.stringify(grantSet);
    expect(canonicalCurrent).toBe(canonicalMainFixture);
    expect(
      createHash('sha256').update(canonicalCurrent).digest('hex')
    ).toBe('2ffcf965c3d50a8bd8e778217d2c7b53fd3154e120095d6b41f5c1f8fa280667');
    for (const [sql] of query.mock.calls) {
      expect(sql).toContain("grant_purpose = 'edge_read'");
    }
  });

  test('pins every shared edge-ledger query and insert to edge_read', () => {
    const source = fs.readFileSync(
      new URL(
        '../../services/downtime/continuityEdgeAccessService.js',
        import.meta.url
      ),
      'utf8'
    );
    const sharedTableStatements = [...source.matchAll(/`([\s\S]*?)`/g)]
      .map(match => match[1])
      .filter(sql => (
        /clinical_continuity_edge_(?:access_grants|access_revocations|log_receipts)/
          .test(sql)
      ));
    expect(sharedTableStatements).toHaveLength(12);
    for (const sql of sharedTableStatements) {
      expect(sql).toContain('grant_purpose');
      expect(sql).toContain('edge_read');
    }
  });

  test('rejects a revoked credential while an unrelated exact grant remains usable', async () => {
    const common = {
      policy_version_id: POLICY_ID,
      policy_version: '12',
      valid_from: '2026-07-30T00:00:00.000Z',
      valid_until: '2026-07-30T04:00:00.000Z'
    };
    const query = jest.fn().mockResolvedValue([
      {
        ...common,
        id: GRANT_ID,
        access_revision: '23',
        revocation_id: '66666666-6666-4666-8666-666666666666',
        revocation_access_revision: '24',
        revoked_at: '2026-07-30T01:00:00.000Z'
      },
      {
        ...common,
        id: '77777777-7777-4777-8777-777777777777',
        access_revision: '22',
        revocation_id: null
      }
    ]);
    const result = await authorizeContinuityEdgeCredential(
      {
        tenantId: TENANT,
        facilityId: FACILITY,
        locationType: 'ward',
        locationIdentifier: 'ward-10',
        staffUid: STAFF,
        deviceId: 'edge-device-01',
        clientCertificateSha256: 'a'.repeat(64),
        trustedAt: '2026-07-30T02:00:00.000Z',
        minimumAccessRevision: '20'
      },
      { scopeRunner: scopeRunner({ $queryRawUnsafe: query }) }
    );

    expect(result.id).toBe('77777777-7777-4777-8777-777777777777');
  });

  test('cannot widen authorization across tenant, facility, location, staff, device, or certificate', async () => {
    const query = jest.fn(async (sql, ...params) => {
      expect(sql).toContain('grant_row.tenant_id = $1::uuid');
      expect(sql).toContain('grant_row.facility_id = $2::integer');
      expect(sql).toContain('grant_row.location_type = $3::varchar');
      expect(sql).toContain('grant_row.location_identifier = $4::varchar');
      expect(sql).toContain('grant_row.staff_uid = $5::uuid');
      expect(sql).toContain('grant_row.device_id = $6::varchar');
      expect(sql).toContain('grant_row.client_certificate_sha256 = $7::char(64)');
      expect(params).toEqual([
        TENANT,
        FACILITY,
        'ward',
        'ward-10',
        STAFF,
        'edge-device-01',
        'a'.repeat(64),
        '2026-07-30T02:00:00.000Z'
      ]);
      return [];
    });

    await expect(
      authorizeContinuityEdgeCredential(
        {
          tenantId: TENANT,
          facilityId: FACILITY,
          locationType: 'ward',
          locationIdentifier: 'ward-10',
          staffUid: STAFF,
          deviceId: 'edge-device-01',
          clientCertificateSha256: 'a'.repeat(64),
          trustedAt: '2026-07-30T02:00:00.000Z',
          minimumAccessRevision: '20'
        },
        { scopeRunner: scopeRunner({ $queryRawUnsafe: query }) }
      )
    ).rejects.toMatchObject({ code: 'CONTINUITY_EDGE_ACCESS_DENIED' });
  });
});

function signedBatch(overrides = {}) {
  const content = {
    accessRevision: '21',
    batchId: 'batch-1',
    deviceId: 'edge-device-01',
    events: [
      { sequence: 1, type: 'pack_viewed' },
      { sequence: 2, type: 'pack_printed' }
    ],
    facilityId: String(FACILITY),
    firstEventAt: '2026-07-30T01:00:00.000Z',
    firstEventSequence: 1,
    format: CONTINUITY_EDGE_LOG_BATCH_FORMAT,
    grantId: GRANT_ID,
    lastEventAt: '2026-07-30T01:01:00.000Z',
    lastEventSequence: 2,
    policyVersion: '12',
    policyVersionId: POLICY_ID,
    previousBatchSha256: null,
    tenantId: TENANT,
    ...overrides
  };
  return {
    algorithm: 'Ed25519',
    content,
    contentHash: hashCanonicalValue(content),
    keyFingerprint: fingerprintContinuityEdgeCertificate(TEST_CERTIFICATE),
    signature: signCanonicalValue(content, TEST_PRIVATE_KEY)
  };
}

describe('continuity recovered access-log ingestion', () => {
  test('verifies signature, grant scope, and first-batch continuity before receipt insert', async () => {
    const envelope = signedBatch();
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: GRANT_ID,
        device_id: 'edge-device-01',
        client_certificate_sha256: envelope.keyFingerprint,
        policy_version_id: POLICY_ID,
        policy_version: '12',
        access_revision: '21',
        valid_from: '2026-07-30T00:00:00.000Z',
        valid_until: '2026-07-30T04:00:00.000Z',
        revocation_access_revision: null,
        revoked_at: null
      }])
      .mockResolvedValueOnce([{ access_revision: '21' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: '88888888-8888-4888-8888-888888888888',
        batch_id: 'batch-1',
        batch_sha256: envelope.contentHash,
        first_event_sequence: '1',
        last_event_sequence: '2'
      }]);

    const receipt = await ingestContinuityEdgeLogBatch(
      { envelope, certificatePem: TEST_CERTIFICATE, importedBy: ACTOR },
      { scopeRunner: scopeRunner({ $queryRawUnsafe: query }) }
    );

    expect(receipt).toMatchObject({ batch_id: 'batch-1', idempotent: false });
    expect(query).toHaveBeenCalledTimes(5);
  });

  test('rejects a gap in the exact device hash chain', async () => {
    const envelope = signedBatch({ previousBatchSha256: 'b'.repeat(64) });
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: GRANT_ID,
        device_id: 'edge-device-01',
        client_certificate_sha256: envelope.keyFingerprint,
        policy_version_id: POLICY_ID,
        policy_version: '12',
        access_revision: '21',
        valid_from: '2026-07-30T00:00:00.000Z',
        valid_until: '2026-07-30T04:00:00.000Z',
        revoked_at: null
      }])
      .mockResolvedValueOnce([{ access_revision: '21' }])
      .mockResolvedValueOnce([{
        batch_sha256: 'a'.repeat(64),
        last_event_sequence: '0'
      }]);

    await expect(
      ingestContinuityEdgeLogBatch(
        { envelope, certificatePem: TEST_CERTIFICATE, importedBy: ACTOR },
        { scopeRunner: scopeRunner({ $queryRawUnsafe: query }) }
      )
    ).rejects.toMatchObject({ code: 'CONTINUITY_EDGE_LOG_CHAIN_GAP' });
  });

  test('requires a one-based genesis batch when no prior receipt exists', async () => {
    const envelope = signedBatch({
      events: [{ action: 'read', sequence: 2 }],
      firstEventSequence: 2,
      lastEventSequence: 2
    });
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: GRANT_ID,
        device_id: 'edge-device-01',
        client_certificate_sha256: envelope.keyFingerprint,
        policy_version_id: POLICY_ID,
        policy_version: '12',
        access_revision: '21',
        valid_from: '2026-07-30T00:00:00.000Z',
        valid_until: '2026-07-30T04:00:00.000Z',
        revoked_at: null
      }])
      .mockResolvedValueOnce([{ access_revision: '21' }])
      .mockResolvedValueOnce([]);

    await expect(
      ingestContinuityEdgeLogBatch(
        { envelope, certificatePem: TEST_CERTIFICATE, importedBy: ACTOR },
        { scopeRunner: scopeRunner({ $queryRawUnsafe: query }) }
      )
    ).rejects.toMatchObject({ code: 'CONTINUITY_EDGE_LOG_CHAIN_GAP' });
  });

  test('returns an exact replay idempotently and rejects conflicting immutable evidence', async () => {
    const envelope = signedBatch();
    const matchingReceipt = {
      id: '88888888-8888-4888-8888-888888888888',
      tenant_id: TENANT,
      facility_id: FACILITY,
      device_id: envelope.content.deviceId,
      grant_id: GRANT_ID,
      client_certificate_sha256: envelope.keyFingerprint,
      policy_version_id: POLICY_ID,
      policy_version: '12',
      access_revision: '21',
      batch_id: 'batch-1',
      previous_batch_sha256: null,
      batch_sha256: envelope.contentHash,
      event_count: 2,
      first_event_sequence: '1',
      last_event_sequence: '2',
      first_event_at: envelope.content.firstEventAt,
      last_event_at: envelope.content.lastEventAt,
      signature_algorithm: 'ed25519',
      signature_sha256: ''
    };
    matchingReceipt.signature_sha256 = createHash('sha256')
      .update(Buffer.from(envelope.signature, 'base64'))
      .digest('hex');

    await expect(
      ingestContinuityEdgeLogBatch(
        { envelope, certificatePem: TEST_CERTIFICATE, importedBy: ACTOR },
        {
          scopeRunner: scopeRunner({
            $queryRawUnsafe: jest.fn().mockResolvedValue([matchingReceipt])
          })
        }
      )
    ).resolves.toMatchObject({ id: matchingReceipt.id, idempotent: true });

    await expect(
      ingestContinuityEdgeLogBatch(
        { envelope, certificatePem: TEST_CERTIFICATE, importedBy: ACTOR },
        {
          scopeRunner: scopeRunner({
            $queryRawUnsafe: jest.fn().mockResolvedValue([{
              ...matchingReceipt,
              batch_sha256: 'f'.repeat(64)
            }])
          })
        }
      )
    ).rejects.toMatchObject({ code: 'CONTINUITY_EDGE_LOG_REPLAY_CONFLICT' });
  });

  test('rejects a future access revision and non-contiguous event content', async () => {
    const nonContiguous = signedBatch({
      events: [
        { sequence: 1, type: 'pack_viewed' },
        { sequence: 3, type: 'pack_printed' }
      ]
    });
    await expect(
      ingestContinuityEdgeLogBatch(
        {
          envelope: nonContiguous,
          certificatePem: TEST_CERTIFICATE,
          importedBy: ACTOR
        },
        { scopeRunner: scopeRunner({ $queryRawUnsafe: jest.fn() }) }
      )
    ).rejects.toMatchObject({ code: 'CONTINUITY_EDGE_LOG_SEQUENCE_INVALID' });

    const futureRevision = signedBatch({ accessRevision: '99' });
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: GRANT_ID,
        device_id: 'edge-device-01',
        client_certificate_sha256: futureRevision.keyFingerprint,
        policy_version_id: POLICY_ID,
        policy_version: '12',
        access_revision: '21',
        valid_from: '2026-07-30T00:00:00.000Z',
        valid_until: '2026-07-30T04:00:00.000Z',
        revoked_at: null
      }])
      .mockResolvedValueOnce([{ access_revision: '21' }]);

    await expect(
      ingestContinuityEdgeLogBatch(
        {
          envelope: futureRevision,
          certificatePem: TEST_CERTIFICATE,
          importedBy: ACTOR
        },
        { scopeRunner: scopeRunner({ $queryRawUnsafe: query }) }
      )
    ).rejects.toMatchObject({
      code: 'CONTINUITY_EDGE_LOG_ACCESS_REVISION_INVALID'
    });
  });

  test('rejects a signature made by evidence other than the supplied certificate', async () => {
    const envelope = signedBatch();
    envelope.content.events[0].type = 'tampered';

    await expect(
      ingestContinuityEdgeLogBatch(
        { envelope, certificatePem: TEST_CERTIFICATE, importedBy: ACTOR },
        { scopeRunner: scopeRunner({ $queryRawUnsafe: jest.fn() }) }
      )
    ).rejects.toMatchObject({ code: 'CONTINUITY_EDGE_LOG_SIGNATURE_INVALID' });
  });
});
