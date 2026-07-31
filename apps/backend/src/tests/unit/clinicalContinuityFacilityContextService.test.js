import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

import { jest } from '@jest/globals';

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  setTenantTx: jest.fn(),
}));

const {
  __facilityContextContractForTests,
  decodeClinicalContinuityFacilityContextHeader,
  encodeClinicalContinuityFacilityContextHeader,
  enrollClinicalContinuityFacilityGrant,
  issueClinicalContinuityFacilityContext,
  listClinicalContinuityFacilityGrants,
  resolveClinicalContinuityFacilityContext,
  revokeClinicalContinuityFacilityGrant,
} = await import(
  '../../services/downtime/clinicalContinuityFacilityContextService.js'
);
const {
  canonicalizeJson,
  hashCanonicalValue,
  signCanonicalValue,
} = await import('../../services/downtime/continuityPackCanonical.js');

const TENANT = '52e31913-c846-4458-a21b-31cd2f457e9b';
const STAFF = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const GRANT = '44444444-4444-4444-8444-444444444444';
const POLICY = '55555555-5555-4555-8555-555555555555';
const FACILITY = 41;
const JTI = 'session-jti-1';
const NOW = new Date('2026-07-30T01:00:00.000Z');

const deviceKeys = generateKeyPairSync('ed25519');
const packKeys = generateKeyPairSync('ed25519');
const devicePublicRaw = deviceKeys.publicKey.export({
  format: 'der',
  type: 'spki',
}).subarray(-32);

function policy() {
  return {
    id: POLICY,
    tenantId: TENANT,
    facilityId: FACILITY,
    policyVersion: '12',
    policySchemaVersion: 3,
    policyChecksum: 'a'.repeat(64),
    policySigningKeyId: 'policy-current',
    currentPackSigningKeyId: 'pack-current',
    revocationEpoch: '4',
    effectiveFrom: '2026-07-30T00:00:00.000Z',
    effectiveUntil: '2026-07-30T04:00:00.000Z',
    trustedKeys: {
      'pack-current': {
        algorithm: 'Ed25519',
        publicKey: packKeys.publicKey,
        state: 'current',
      },
    },
  };
}

function grant() {
  return {
    id: GRANT,
    tenant_id: TENANT,
    facility_id: FACILITY,
    grant_purpose: 'capture_staff_facility',
    staff_uid: STAFF,
    device_id: DEVICE,
    device_public_key_raw: devicePublicRaw,
    device_credential_sha256: createHash('sha256')
      .update(devicePublicRaw)
      .digest('hex'),
    valid_from: '2026-07-30T00:00:00.000Z',
    valid_until: '2026-07-30T03:00:00.000Z',
    policy_version_id: POLICY,
    policy_version: '12',
    capture_revision: '21',
  };
}

function deviceProof() {
  const signedAt = NOW.toISOString();
  const content = {
    actorUid: STAFF,
    deviceId: DEVICE,
    facilityId: String(FACILITY),
    format: 'vhhealth_continuity_facility_proof/v1',
    nonce: '66666666-6666-4666-8666-666666666666',
    sessionJtiSha256: createHash('sha256').update(JTI).digest('hex'),
    signedAt,
    tenantId: TENANT,
  };
  return {
    nonce: content.nonce,
    signature: signCanonicalValue(content, deviceKeys.privateKey),
    signedAt,
  };
}

function signer() {
  return {
    sign: jest.fn(async ({ algorithm, keyId, payload }) => {
      expect(algorithm).toBe('Ed25519');
      expect(keyId).toBe('pack-current');
      return sign(null, payload, packKeys.privateKey).toString('base64');
    }),
  };
}

function issueScope({ projectionCount = 1 } = {}) {
  const query = jest
    .fn()
    .mockResolvedValueOnce([grant()])
    .mockResolvedValueOnce([{ context_revision: '31' }]);
  const execute = jest.fn().mockResolvedValue(projectionCount);
  return {
    query,
    execute,
    runner: async (_tenantId, callback, options) => {
      expect(options).toEqual({ isolationLevel: 'RepeatableRead' });
      return callback({
        $queryRawUnsafe: query,
        $executeRawUnsafe: execute,
      });
    },
  };
}

async function issue(overrides = {}) {
  const scope = issueScope(overrides);
  const envelope = await issueClinicalContinuityFacilityContext({
    tenantId: TENANT,
    actorUid: STAFF,
    stableDeviceId: DEVICE,
    sessionJti: JTI,
    sessionExpiresAt: '2026-07-30T02:00:00.000Z',
    requestedFacilityId: FACILITY,
    deviceProof: deviceProof(),
    signer: signer(),
    contextLifetimeMs: 30 * 60 * 1000,
    clock: () => NOW,
    scopeRunner: scope.runner,
    policyLoader: async () => policy(),
  });
  return { envelope, scope };
}

function signedEnvelope(envelope, overrides = {}, privateKey = packKeys.privateKey) {
  const content = { ...envelope.content, ...overrides };
  return {
    algorithm: envelope.algorithm,
    content,
    contentHash: hashCanonicalValue(content),
    keyId: envelope.keyId,
    signature: signCanonicalValue(content, privateKey),
  };
}

function resolveScope({
  grantRows = [grant()],
  projectionRows = [{ '?column?': 1 }],
} = {}) {
  const query = jest
    .fn()
    .mockResolvedValueOnce(grantRows)
    .mockResolvedValueOnce(projectionRows);
  return {
    query,
    runner: async (_tenantId, callback, options) => {
      expect(options).toEqual({
        readOnly: true,
        isolationLevel: 'RepeatableRead',
      });
      return callback({ $queryRawUnsafe: query });
    },
  };
}

function request(overrides = {}) {
  return {
    tenantId: TENANT,
    user: {
      uid: STAFF,
      stableDeviceId: DEVICE,
      jti: JTI,
    },
    ...overrides,
  };
}

describe('clinical continuity facility context service', () => {
  test('issues a signed context and updates exactly one tenant projection', async () => {
    const { envelope, scope } = await issue();
    expect(envelope.content).toMatchObject({
      captureRevision: '21',
      contextRevision: '31',
      deviceId: DEVICE,
      expiresAt: '2026-07-30T01:30:00.000Z',
      facilityId: '41',
      grantId: GRANT,
      grantPurpose: 'capture_staff_facility',
      sessionJtiSha256: createHash('sha256').update(JTI).digest('hex'),
      staffUid: STAFF,
      tenantId: TENANT,
    });
    expect(scope.execute).toHaveBeenCalledTimes(1);
    const [projectionSql, ...projectionParams] = scope.execute.mock.calls[0];
    expect(projectionSql).toContain('WHERE tenant_id = $1::uuid');
    expect(projectionSql).toContain('AND user_uid = $2::uuid');
    expect(projectionSql).toContain('AND device_id = $3');
    expect(projectionParams.slice(0, 4)).toEqual([
      TENANT,
      STAFF,
      DEVICE,
      FACILITY,
    ]);
  });

  test('denies issuance without the C-D14 lifetime or exact projection row', async () => {
    const missingLifetime = issueScope();
    await expect(
      issueClinicalContinuityFacilityContext({
        tenantId: TENANT,
        actorUid: STAFF,
        stableDeviceId: DEVICE,
        sessionJti: JTI,
        sessionExpiresAt: '2026-07-30T02:00:00.000Z',
        requestedFacilityId: FACILITY,
        deviceProof: deviceProof(),
        signer: signer(),
        contextLifetimeMs: undefined,
        clock: () => NOW,
        scopeRunner: missingLifetime.runner,
        policyLoader: async () => policy(),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_OWNER_DECISION_REQUIRED',
    });
    await expect(issue({ projectionCount: 0 })).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });
  });

  test('resolves only the exact session and freezes the C5.1 request seam', async () => {
    const { envelope } = await issue();
    const query = jest
      .fn()
      .mockResolvedValueOnce([grant()])
      .mockResolvedValueOnce([{ '?column?': 1 }]);
    const req = {
      tenantId: TENANT,
      user: {
        uid: STAFF,
        stableDeviceId: DEVICE,
        jti: JTI,
      },
    };
    const result = await resolveClinicalContinuityFacilityContext({
      req,
      envelope,
      clientFacilityId: FACILITY,
      clock: () => new Date('2026-07-30T01:10:00.000Z'),
      scopeRunner: async (_tenantId, callback, options) => {
        expect(options).toEqual({
          readOnly: true,
          isolationLevel: 'RepeatableRead',
        });
        return callback({ $queryRawUnsafe: query });
      },
      policyLoader: async () => policy(),
    });
    expect(Object.keys(result).sort()).toEqual(
      __facilityContextContractForTests.requestPropertyKeys,
    );
    expect(req.continuityFacilityContext).toBe(result);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      req.continuityFacilityContext = {};
    }).toThrow(TypeError);
    expect(() => {
      result.facilityId = 99;
    }).toThrow(TypeError);
  });

  test('round-trips only canonical header bytes and rejects facility drift', async () => {
    const { envelope } = await issue();
    const header = encodeClinicalContinuityFacilityContextHeader(envelope);
    expect(decodeClinicalContinuityFacilityContextHeader(header)).toEqual(
      envelope,
    );
    const nonCanonicalEnvelope = {
      signature: envelope.signature,
      algorithm: envelope.algorithm,
      content: envelope.content,
      contentHash: envelope.contentHash,
      keyId: envelope.keyId,
    };
    const nonCanonical = Buffer.from(
      JSON.stringify(nonCanonicalEnvelope),
      'utf8',
    ).toString('base64url');
    expect(() =>
      decodeClinicalContinuityFacilityContextHeader(nonCanonical),
    ).toThrow();
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: {
          tenantId: TENANT,
          user: { uid: STAFF, stableDeviceId: DEVICE, jti: JTI },
        },
        envelope,
        clientFacilityId: FACILITY + 1,
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });
  });

  test('signed content stays canonical for transport and storage', async () => {
    const { envelope } = await issue();
    const canonical = canonicalizeJson(envelope);
    expect(JSON.parse(canonical)).toEqual(envelope);
    expect(Object.keys(envelope.content).sort()).toEqual(
      __facilityContextContractForTests.contentKeys,
    );
  });

  test.each([
    [
      'expired',
      { expiresAt: '2026-07-30T01:09:59.999Z' },
      {},
    ],
    [
      'not yet effective',
      { effectiveFrom: '2026-07-30T01:10:00.001Z' },
      {},
    ],
    [
      'wrong tenant',
      { tenantId: '77777777-7777-4777-8777-777777777777' },
      {},
    ],
    [
      'default tenant',
      { tenantId: '00000000-0000-4000-8000-000000000001' },
      {},
    ],
    [
      'wrong user',
      { staffUid: '77777777-7777-4777-8777-777777777777' },
      {},
    ],
    [
      'wrong device',
      { deviceId: '77777777-7777-4777-8777-777777777777' },
      {},
    ],
    [
      'wrong session',
      { sessionJtiSha256: 'b'.repeat(64) },
      {},
    ],
  ])('denies a %s signed context before projection lookup', async (
    _label,
    contentOverrides,
    requestOverrides,
  ) => {
    const { envelope } = await issue();
    const scope = resolveScope();
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(requestOverrides),
        envelope: signedEnvelope(envelope, contentOverrides),
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
        scopeRunner: scope.runner,
        policyLoader: async () => policy(),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });
    expect(scope.query).not.toHaveBeenCalled();
  });

  test.each([
    [
      'wrong grant',
      { grantId: '77777777-7777-4777-8777-777777777777' },
    ],
    ['wrong purpose', { grantPurpose: 'capture_fixed_device' }],
    ['superseded capture revision', { captureRevision: '20' }],
    [
      'wrong policy',
      { policyId: '77777777-7777-4777-8777-777777777777' },
    ],
    ['wrong policy version', { policyVersion: '11' }],
    ['wrong policy checksum', { policyChecksum: 'b'.repeat(64) }],
    ['wrong policy signing key', { policySigningKeyId: 'policy-old' }],
    ['wrong revocation epoch', { revocationEpoch: '3' }],
  ])('denies a context carrying the %s', async (_label, contentOverrides) => {
    const { envelope } = await issue();
    const scope = resolveScope();
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(),
        envelope: signedEnvelope(envelope, contentOverrides),
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
        scopeRunner: scope.runner,
        policyLoader: async () => policy(),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });
  });

  test('denies forged, malformed, revoked, and superseded contexts', async () => {
    const { envelope } = await issue();
    const forgedKeys = generateKeyPairSync('ed25519');
    const forgedScope = resolveScope();
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(),
        envelope: signedEnvelope(envelope, {}, forgedKeys.privateKey),
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
        scopeRunner: forgedScope.runner,
        policyLoader: async () => policy(),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });

    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(),
        envelope: { ...envelope, unexpected: true },
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });

    const revokedScope = resolveScope({ grantRows: [] });
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(),
        envelope,
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
        scopeRunner: revokedScope.runner,
        policyLoader: async () => policy(),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });

    const supersededScope = resolveScope({ projectionRows: [] });
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(),
        envelope,
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
        scopeRunner: supersededScope.runner,
        policyLoader: async () => policy(),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });
  });

  test('denies wrong facility evidence and a non-current signing key', async () => {
    const { envelope } = await issue();
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(),
        envelope,
        clientFacilityId: FACILITY + 1,
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });

    const oldKeyEnvelope = {
      ...envelope,
      keyId: 'pack-old',
    };
    const scope = resolveScope();
    await expect(
      resolveClinicalContinuityFacilityContext({
        req: request(),
        envelope: oldKeyEnvelope,
        clock: () => new Date('2026-07-30T01:10:00.000Z'),
        scopeRunner: scope.runner,
        policyLoader: async () => ({
          ...policy(),
          trustedKeys: {
            ...policy().trustedKeys,
            'pack-old': {
              algorithm: 'Ed25519',
              publicKey: packKeys.publicKey,
              state: 'retired',
            },
          },
        }),
      }),
    ).rejects.toMatchObject({
      code: 'CONTINUITY_FACILITY_CONTEXT_DENIED',
    });
  });

  test('enrolls only a policy-bounded capture grant with a raw Ed25519 key', async () => {
    const enrolled = {
      id: GRANT,
      grant_purpose: 'capture_staff_facility',
    };
    const query = jest.fn().mockResolvedValueOnce([enrolled]);
    const result = await enrollClinicalContinuityFacilityGrant({
      tenantId: TENANT,
      facilityId: FACILITY,
      grantPurpose: 'capture_staff_facility',
      staffUid: STAFF,
      deviceId: DEVICE,
      devicePublicKeyBase64: devicePublicRaw.toString('base64'),
      validFrom: '2026-07-30T00:30:00.000Z',
      validUntil: '2026-07-30T03:30:00.000Z',
      createdBy: STAFF,
      scopeRunner: async (_tenantId, callback, options) => {
        expect(options).toEqual({ isolationLevel: 'Serializable' });
        return callback({ $queryRawUnsafe: query });
      },
      policyLoader: async () => policy(),
    });

    expect(result).toBe(enrolled);
    const [sql, ...params] = query.mock.calls[0];
    expect(sql).toContain('grant_purpose');
    expect(sql).toContain(
      "nextval('clinical_continuity_capture_revision_seq')",
    );
    expect(params).toContain('capture_staff_facility');
    expect(params).toContain('staff_device');
    expect(params).toContain(
      createHash('sha256').update(devicePublicRaw).digest('hex'),
    );
  });

  test('lists capture grants without exposing edge grants', async () => {
    const grants = [{ id: GRANT }];
    const query = jest.fn().mockResolvedValueOnce(grants);
    const result = await listClinicalContinuityFacilityGrants({
      tenantId: TENANT,
      facilityId: FACILITY,
      scopeRunner: async (_tenantId, callback, options) => {
        expect(options).toEqual({
          readOnly: true,
          isolationLevel: 'RepeatableRead',
        });
        return callback({ $queryRawUnsafe: query });
      },
    });

    expect(result).toBe(grants);
    const [sql, ...params] = query.mock.calls[0];
    expect(sql).toContain("grant_row.grant_purpose IN (");
    expect(sql).toContain("'capture_fixed_device'");
    expect(sql).toContain("'capture_staff_facility'");
    expect(sql).not.toContain("'edge_read'");
    expect(params).toEqual([TENANT, FACILITY]);
  });

  test('revokes only an active capture grant with a capture revision', async () => {
    const revocation = { id: '77777777-7777-4777-8777-777777777777' };
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { grant_purpose: 'capture_fixed_device' },
      ])
      .mockResolvedValueOnce([revocation]);
    const result = await revokeClinicalContinuityFacilityGrant({
      tenantId: TENANT,
      facilityId: FACILITY,
      grantId: GRANT,
      revokedBy: STAFF,
      reason: 'Device retired',
      scopeRunner: async (_tenantId, callback, options) => {
        expect(options).toEqual({ isolationLevel: 'Serializable' });
        return callback({ $queryRawUnsafe: query });
      },
    });

    expect(result).toBe(revocation);
    expect(query.mock.calls[0][0]).toContain(
      "grant_row.grant_purpose IN (",
    );
    expect(query.mock.calls[1][0]).toContain(
      "nextval('clinical_continuity_capture_revision_seq')",
    );
    expect(query.mock.calls[1].slice(1)).toContain('capture_fixed_device');
  });
});
