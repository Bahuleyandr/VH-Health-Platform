import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import {
  canonicalizeJson,
  createSignedPackEnvelope
} from '../../services/downtime/continuityPackCanonical.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const EDGE_POLICY_SCHEMA_VERSION = 2;
const TENANT_A = '10000000-0000-4000-8000-000000000001';
const TENANT_B = '20000000-0000-4000-8000-000000000002';
const POLICY_A = 'a0000000-0000-4000-8000-000000000001';
const POLICY_B = 'b0000000-0000-4000-8000-000000000002';
const GENERATED_AT = '2026-07-29T06:00:00.000Z';
const PUBLISHED_AT = '2026-07-29T06:00:01.000Z';
const FRESH_UNTIL = '2026-07-29T06:15:00.000Z';
const EXPIRES_AT = '2026-07-30T06:00:00.000Z';

let featureEnabled = false;
let sequenceValue = 600n;
let policies = [];
let policyByFacility = new Map();
let privateKeyById = new Map();
let producedByFacility = new Map();
let txRecords = [];
let events = [];
let evidenceFailure = null;
let databasePublishedAt = PUBLISHED_AT;

const getPublicationRoot = jest.fn(() => 'D:\\continuity-test-publication');
const enumeratePolicies = jest.fn(async () => policies);
const loadPolicyForFacility = jest.fn(async ({ tenantId, facilityId }) =>
  policyByFacility.get(`${tenantId}/${facilityId}`)
);
const produceFacilityPacks = jest.fn(async ({ tenantId, facilityId }) =>
  producedByFacility.get(`${tenantId}/${facilityId}`)
);
const renderPack = jest.fn(
  pack => `<!doctype html><title>${pack.tenant_id}/${pack.location.identifier}</title>`
);
const getUnifiedActiveAllergies = jest.fn();
const legacyPrisma = {
  $executeRawUnsafe: jest.fn(),
  $queryRawUnsafe: jest.fn(),
  downtime_snapshots: { create: jest.fn() }
};

const setTenantTx = jest.fn(async (tenantId, callback, options = {}) => {
  events.push(`tx:${tenantId}:${options.isolationLevel || 'default'}`);
  const tx = {
    $executeRawUnsafe: jest.fn(async () => {
      events.push(`evidence:${tenantId}`);
      if (evidenceFailure) throw evidenceFailure;
      return 1;
    }),
    $queryRawUnsafe: jest.fn(async sql => {
      if (sql.includes('nextval')) {
        sequenceValue += 1n;
        return [{ manifest_version: sequenceValue.toString() }];
      }
      if (sql.includes('clock_timestamp')) {
        return [{ published_at: databasePublishedAt }];
      }
      throw new Error(`Unexpected test query: ${sql}`);
    })
  };
  txRecords.push({ tenantId, options, tx });
  return callback(tx);
});

const publishPackSet = jest.fn(async options => {
  events.push(`stage:${options.tenantId}/${options.facilityId}`);
  const receipt = {
    tenantId: options.tenantId,
    facilityId: options.facilityId,
    manifestVersion: options.manifestVersion,
    manifestSha256: createHash('sha256').update(options.manifestContent).digest('hex'),
    setName: `v${options.manifestVersion}`,
    coverage: options.requiredCoverage,
    assets: options.assets.map(asset => ({
      locationType: asset.locationType.toLowerCase(),
      locationId: asset.locationId.toLowerCase(),
      relativePath:
        `${asset.locationType.toLowerCase()}/` +
        `${asset.locationId.toLowerCase()}/${asset.relativePath}`,
      sha256: createHash('sha256').update(asset.content).digest('hex')
    })),
    rootAssets: (options.rootAssets || []).map(asset => ({
      relativePath: asset.relativePath,
      sha256: createHash('sha256').update(asset.content).digest('hex')
    }))
  };
  await options.commitEvidence(receipt);
  events.push(`pointer:${options.tenantId}/${options.facilityId}`);
  return {
    tenantId: options.tenantId,
    facilityId: options.facilityId,
    manifestVersion: options.manifestVersion,
    manifestSha256: receipt.manifestSha256
  };
});
const buildEdgeGrantSet = jest.fn(async ({ policy }) => ({
  accessRevision: '31',
  audience: {
    tenantId: policy.tenantId,
    facilityId: String(policy.facilityId)
  },
  edgeAccess: policy.policyDocument.edgeAccess,
  format: 'vhhealth_clinical_continuity_edge_access/v1',
  generatedAt: policy.trustedNow,
  grants: [],
  policy: {
    id: policy.id,
    version: policy.policyVersion,
    revocationEpoch: policy.revocationEpoch
  },
  revocations: []
}));

function buildPublicationPaths({ root, tenantId, facilityId, manifestVersion }) {
  const facilityDir = path.join(
    root,
    'continuity-v1',
    'tenants',
    tenantId,
    'facilities',
    String(facilityId)
  );
  return {
    root,
    tenantId,
    facilityId,
    manifestVersion: String(manifestVersion),
    facilityDir,
    setsDir: path.join(facilityDir, 'sets'),
    currentPath: path.join(facilityDir, 'current.json')
  };
}

jest.unstable_mockModule('../../config/downtimeConfig.js', () => ({
  clinicalContinuityPacksEnabled: jest.fn(() => featureEnabled),
  getClinicalContinuityPublicationRoot: getPublicationRoot,
  getDowntimeMirrorDir: jest.fn(() => 'D:\\legacy-mirror')
}));
jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: legacyPrisma,
  setTenantTx
}));
jest.unstable_mockModule('../../services/downtime/clinicalContinuityPolicyService.js', () => ({
  DEFAULT_TENANT_ID,
  CLINICAL_CONTINUITY_EDGE_POLICY_SCHEMA_VERSION: EDGE_POLICY_SCHEMA_VERSION,
  enumerateActiveClinicalContinuityPolicies: enumeratePolicies,
  loadActiveClinicalContinuityPolicyForFacilityTx: loadPolicyForFacility,
  requireClinicalContinuityEdgePolicy: policy => {
    if (policy.policySchemaVersion !== EDGE_POLICY_SCHEMA_VERSION) {
      const error = new Error('edge policy required');
      error.code = 'CONTINUITY_EDGE_POLICY_REQUIRED';
      throw error;
    }
    return {
      edgeAccess: policy.policyDocument.edgeAccess,
      retention: policy.policyDocument.retention
    };
  }
}));
jest.unstable_mockModule('../../services/downtime/continuityPackProducers.js', () => ({
  produceFacilityContinuityPacks: produceFacilityPacks
}));
jest.unstable_mockModule('../../services/downtime/continuityPackPublicationService.js', () => ({
  buildContinuityPackPaths: buildPublicationPaths,
  normalizeCoverageLocation: location => ({
    locationType: location.locationType.toLowerCase(),
    locationId: location.locationId.toLowerCase()
  }),
  publishContinuityPackSet: publishPackSet
}));
jest.unstable_mockModule('../../services/downtime/continuityEdgeAccessService.js', () => ({
  buildContinuityEdgeGrantSet: buildEdgeGrantSet
}));
jest.unstable_mockModule('../../services/downtime/continuityPackRenderer.js', () => ({
  buildContinuityPackHtml: renderPack,
  // C-D2's countersigned unknown-state wording. The legacy ward-pack renderer
  // imports these from here so both renderers say the same sentence; the mock
  // has to carry them or wardDowntimePackService cannot load.
  ALLERGY_UNKNOWN_TEXT: 'Allergy status UNKNOWN — not recorded',
  CODE_STATUS_UNKNOWN_TEXT: 'Code status NOT RECORDED — confirm per hospital policy'
}));
jest.unstable_mockModule('../../services/clinical/allergySourceService.js', () => ({
  getUnifiedActiveAllergies
}));
jest.unstable_mockModule('../../logging/logger.js', () => ({
  default: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn()
  }
}));

const {
  ClinicalContinuityPackOrchestrationError,
  __testing__,
  generateClinicalContinuityPackSets,
  purgeClinicalContinuitySourceSets
} =
  await import('../../services/downtime/clinicalContinuityPackOrchestrationService.js');
const { generateWardDowntimePacks } =
  await import('../../services/downtime/wardDowntimePackService.js');

function publicPem(publicKey) {
  return publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

function makePolicy({
  tenantId = TENANT_A,
  facilityId = 11,
  policyId = POLICY_A,
  keyId = 'pack-key-a',
  coverage = {
    wards: [{ wardId: 41, locationIdentifier: 'ward-41' }],
    paediatricWards: [],
    edBoards: [],
    opdClinicDays: []
  },
  policySchemaVersion = 1
} = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  privateKeyById.set(keyId, privateKey);
  return Object.freeze({
    id: policyId,
    tenantId,
    facilityId,
    facilityDisplayName: `Facility ${facilityId}`,
    facilityTimezone: 'Asia/Kolkata',
    policyVersion: '7',
    policySchemaVersion,
    packSchemaVersion: 1,
    policyDocument: {
      requiredCoverage: coverage,
      ...(policySchemaVersion === EDGE_POLICY_SCHEMA_VERSION
        ? {
          edgeAccess: {
            authenticationMode: 'mtls_client_certificate',
            credentialLifetimeMinutes: 480,
            emergencyReadPosture: 'read_only',
            maximumOfflineAuthorizationMinutes: 60
          },
          retention: {
            recoveredLogReceiptHours: 8760,
            sourcePackRetentionHours: 24
          }
        }
        : {})
    },
    policyChecksum: 'a'.repeat(64),
    currentPackSigningKeyId: keyId,
    nextPackSigningKeyId: null,
    revocationEpoch: '2',
    minimumPolicyVersion: '7',
    minimumRevocationEpoch: '2',
    trustedNow: GENERATED_AT,
    trustedKeys: {
      [keyId]: {
        algorithm: 'Ed25519',
        publicKey: publicPem(publicKey),
        state: 'current'
      }
    }
  });
}

function known(value, recordedAt = GENERATED_AT) {
  return {
    state: 'known',
    value,
    recorded_at: recordedAt,
    source: 'test',
    timestamp_basis: 'source_recorded_at'
  };
}

function makePatient(locationType) {
  const patient = {
    identity: known({
      name: known('Test Patient'),
      mrn: known('MRN-1'),
      uid: known('30000000-0000-4000-8000-000000000003'),
      dob: known('2015-01-01'),
      identity_status: 'identified'
    }),
    allergies: known([]),
    code_status: known('full_code'),
    isolation: known([]),
    location: known({ bed_number: '1' }),
    attending: known({ name: 'Dr Test' }),
    diagnosis: known('Test diagnosis'),
    latest_vitals: known({ heart_rate: 80 }),
    news2: known({ total_score: 0 }),
    medications_due: known([]),
    active_medication_orders: known([]),
    recently_administered_medications: known([]),
    unresolved_critical_results: known([]),
    recent_released_results: known([]),
    care_team: known([])
  };
  if (locationType === 'paeds') patient.latest_weight = known({ kg: 28 });
  if (locationType === 'ed_board') {
    patient.arrival_at = known('2026-07-29T05:00:00.000Z');
    patient.triage = known({ level: 'urgent' });
    patient.time_in_department = known({ minutes: 60 });
  }
  if (locationType === 'opd_day') {
    patient.appointment_time = known('2026-07-29T06:30:00.000Z');
    patient.appointment_status = known('scheduled');
    patient.phone = known('+910000000000');
  }
  return patient;
}

function locationForCoverage(coverage) {
  if (coverage.wards?.length) {
    const entry = coverage.wards[0];
    return {
      type: 'ward',
      identifier: entry.locationIdentifier || `ward-${entry.wardId}`,
      id: entry.locationIdentifier || `ward-${entry.wardId}`,
      label: 'Ward',
      ward_id: String(entry.wardId)
    };
  }
  if (coverage.paediatricWards?.length) {
    const entry = coverage.paediatricWards[0];
    return {
      type: 'paeds',
      identifier: entry.locationIdentifier || `ward-${entry.wardId}`,
      id: entry.locationIdentifier || `ward-${entry.wardId}`,
      label: 'Paediatric ward',
      ward_id: String(entry.wardId)
    };
  }
  if (coverage.edBoards?.length) {
    return {
      type: 'ed_board',
      identifier: coverage.edBoards[0].locationIdentifier,
      id: coverage.edBoards[0].locationIdentifier,
      label: 'ED board'
    };
  }
  return {
    type: 'opd_day',
    identifier: coverage.opdClinicDays[0].locationIdentifier,
    id: coverage.opdClinicDays[0].locationIdentifier,
    label: 'OPD clinic day'
  };
}

function makePack(policy, location, { patients = [] } = {}) {
  return {
    pack_schema_version: 1,
    tenant_id: policy.tenantId,
    facility: {
      id: String(policy.facilityId),
      code: `FAC-${policy.facilityId}`,
      name: policy.facilityDisplayName,
      timezone: policy.facilityTimezone
    },
    location,
    policy: {
      id: policy.id,
      version: policy.policyVersion,
      revocation_epoch: policy.revocationEpoch
    },
    source_watermark: {
      captured_at: GENERATED_AT,
      txid_snapshot: '100:100:',
      transaction_id: '100',
      transaction_isolation: 'repeatable read'
    },
    generated_at: GENERATED_AT,
    fresh_until: FRESH_UNTIL,
    expires_at: EXPIRES_AT,
    not_valid_after: EXPIRES_AT,
    historical_mode: false,
    patients,
    ...(location.type === 'opd_day'
      ? { handling: { printed_sheet: 'DESTROY AFTER CLINIC DAY' } }
      : {})
  };
}

function makeProduced(policy, packs) {
  return {
    tenant_id: policy.tenantId,
    facility: packs[0].facility,
    policy_version: policy.policyVersion,
    policy_version_id: policy.id,
    source_watermark: packs[0].source_watermark,
    packs
  };
}

function signer() {
  return {
    sign: jest.fn(async ({ keyId, canonicalPayload, payload }) => {
      const signingInput = canonicalPayload ?? payload;
      events.push(`sign:${keyId}`);
      return cryptoSign(
        null,
        Buffer.isBuffer(signingInput) ? signingInput : Buffer.from(signingInput, 'utf8'),
        privateKeyById.get(keyId)
      ).toString('base64');
    })
  };
}

function registerPolicy(policy, packs) {
  policies.push(policy);
  const key = `${policy.tenantId}/${policy.facilityId}`;
  policyByFacility.set(key, policy);
  producedByFacility.set(key, makeProduced(policy, packs));
}

beforeEach(() => {
  featureEnabled = false;
  sequenceValue = 600n;
  policies = [];
  policyByFacility = new Map();
  privateKeyById = new Map();
  producedByFacility = new Map();
  txRecords = [];
  events = [];
  evidenceFailure = null;
  databasePublishedAt = PUBLISHED_AT;
  jest.clearAllMocks();
});

describe('C3.1 ward Cron overload', () => {
  it('keeps the true no-argument sweep inert before DB, clinical, and filesystem access', async () => {
    await expect(generateWardDowntimePacks()).resolves.toEqual([]);

    expect(getPublicationRoot).not.toHaveBeenCalled();
    expect(enumeratePolicies).not.toHaveBeenCalled();
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
    expect(legacyPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { generatedBy: '30000000-0000-4000-8000-000000000003' },
    { tenantId: undefined },
    { tenantId: '' }
  ])('rejects an explicitly supplied legacy call without tenantId: %p', async options => {
    await expect(generateWardDowntimePacks(options)).rejects.toThrow('requires a tenantId');
    expect(enumeratePolicies).not.toHaveBeenCalled();
    expect(legacyPrisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('keeps an explicit tenant call on the legacy route branch', async () => {
    featureEnabled = true;
    legacyPrisma.$queryRawUnsafe.mockResolvedValueOnce([]);
    legacyPrisma.$executeRawUnsafe.mockResolvedValueOnce(0);

    await expect(
      generateWardDowntimePacks({
        tenantId: TENANT_A,
        generatedBy: null
      })
    ).resolves.toEqual([]);

    expect(legacyPrisma.$queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(legacyPrisma.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(enumeratePolicies).not.toHaveBeenCalled();
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
  });
});

describe('C3.1 facility pack-set orchestration', () => {
  it('returns before policy, signer, clinical, transaction, or publication work when disabled', async () => {
    const externalSigner = signer();

    await expect(generateClinicalContinuityPackSets({ signer: externalSigner })).resolves.toEqual(
      []
    );

    expect(getPublicationRoot).not.toHaveBeenCalled();
    expect(enumeratePolicies).not.toHaveBeenCalled();
    expect(externalSigner.sign).not.toHaveBeenCalled();
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
  });

  it('preflights all external keys before PHI reads and publishes tenant/facility-namespaced sets', async () => {
    featureEnabled = true;
    const policyA = makePolicy();
    const policyB = makePolicy({
      tenantId: TENANT_B,
      facilityId: 22,
      policyId: POLICY_B,
      keyId: 'pack-key-b',
      coverage: {
        wards: [],
        paediatricWards: [],
        edBoards: [{ locationIdentifier: 'ed-main' }],
        opdClinicDays: []
      }
    });
    const locationA = locationForCoverage(policyA.policyDocument.requiredCoverage);
    const locationB = locationForCoverage(policyB.policyDocument.requiredCoverage);
    registerPolicy(policyA, [makePack(policyA, locationA, { patients: [] })]);
    registerPolicy(policyB, [
      makePack(policyB, locationB, {
        patients: [makePatient('ed_board')]
      })
    ]);
    const externalSigner = signer();

    const results = await generateClinicalContinuityPackSets({
      signer: externalSigner
    });

    expect(results).toHaveLength(2);
    expect(publishPackSet).toHaveBeenCalledTimes(2);
    for (const [options] of publishPackSet.mock.calls) {
      const htmlAsset = options.assets.find(asset => asset.relativePath === 'pack.html');
      const jsonAsset = options.assets.find(
        asset =>
          asset.relativePath === 'pack.json' &&
          asset.locationType === htmlAsset.locationType &&
          asset.locationId === htmlAsset.locationId
      );
      expect(JSON.parse(jsonAsset.content).renderHash).toBe(
        createHash('sha256').update(htmlAsset.content).digest('hex')
      );
    }
    expect(
      publishPackSet.mock.calls.map(([options]) => [
        options.root,
        options.tenantId,
        options.facilityId
      ])
    ).toEqual([
      ['D:\\continuity-test-publication', TENANT_A, 11],
      ['D:\\continuity-test-publication', TENANT_B, 22]
    ]);
    expect(
      setTenantTx.mock.calls
        .filter(([, , options]) => options?.isolationLevel === 'RepeatableRead')
        .map(([tenantId]) => tenantId)
    ).toEqual([TENANT_A, TENANT_B]);
    expect(events.slice(0, 2).every(event => event.startsWith('sign:'))).toBe(true);
    expect(events.indexOf(`tx:${TENANT_A}:RepeatableRead`)).toBeGreaterThan(1);
    expect(events.indexOf(`tx:${TENANT_B}:RepeatableRead`)).toBeGreaterThan(1);
    expect(events.indexOf(`evidence:${TENANT_A}`)).toBeLessThan(
      events.indexOf(`pointer:${TENANT_A}/11`)
    );
    expect(events.indexOf(`evidence:${TENANT_B}`)).toBeLessThan(
      events.indexOf(`pointer:${TENANT_B}/22`)
    );

    const evidenceTransactions = txRecords.filter(
      ({ options }) => options.isolationLevel === undefined
    );
    expect(evidenceTransactions).toHaveLength(2);
    for (const record of evidenceTransactions) {
      expect(record.tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
      const evidenceArgs = record.tx.$executeRawUnsafe.mock.calls[0];
      const publication = publishPackSet.mock.calls.find(
        ([options]) => options.tenantId === record.tenantId
      )[0];
      const signedManifest = JSON.parse(publication.manifestContent);
      expect(signedManifest.content.publicationSetId).toMatch(/^[0-9a-f-]{36}$/);
      expect(evidenceArgs[12]).toBe(signedManifest.content.publicationSetId);
      const [
        sql,
        tenantId,
        ,
        ,
        ,
        ,
        expiresAt,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        ,
        algorithm,
        ,
        signatureBytes,
        ,
        ,
        ,
        ,
        retentionUntil
      ] = record.tx.$executeRawUnsafe.mock.calls[0];
      expect(sql).toContain(`'clinical_continuity_pack'`);
      expect(tenantId).toBe(record.tenantId);
      expect(tenantId).not.toBe(DEFAULT_TENANT_ID);
      expect(algorithm).toBe('ed25519');
      expect(signatureBytes).toBeInstanceOf(Buffer);
      expect(signatureBytes).toHaveLength(64);
      expect(retentionUntil).toBe(expiresAt);
    }
  });

  it('publishes a signed edge-access root asset only for a verified v2 policy', async () => {
    featureEnabled = true;
    const policy = makePolicy({ policySchemaVersion: EDGE_POLICY_SCHEMA_VERSION });
    const location = locationForCoverage(policy.policyDocument.requiredCoverage);
    registerPolicy(policy, [makePack(policy, location)]);

    await generateClinicalContinuityPackSets({ signer: signer() });

    expect(buildEdgeGrantSet).toHaveBeenCalledWith({
      tx: expect.any(Object),
      policy
    });
    const [publication] = publishPackSet.mock.calls[0];
    expect(publication.rootAssets).toHaveLength(1);
    expect(publication.rootAssets[0].relativePath).toBe('edge-access.json');
    const edgeEnvelope = JSON.parse(publication.rootAssets[0].content);
    const manifestEnvelope = JSON.parse(publication.manifestContent);
    expect(edgeEnvelope.content).toMatchObject({
      accessRevision: '31',
      format: 'vhhealth_clinical_continuity_edge_access/v1'
    });
    expect(manifestEnvelope.content.edgeAccess).toEqual({
      accessRevision: '31',
      path: 'edge-access.json',
      sha256: createHash('sha256')
        .update(publication.rootAssets[0].content)
        .digest('hex')
    });
  });

  it('fails the whole facility set before rendering or publication when coverage is partial', async () => {
    featureEnabled = true;
    const policy = makePolicy({
      coverage: {
        wards: [{ wardId: 41, locationIdentifier: 'ward-41' }],
        paediatricWards: [],
        edBoards: [{ locationIdentifier: 'ed-main' }],
        opdClinicDays: []
      }
    });
    registerPolicy(policy, [
      makePack(policy, {
        type: 'ward',
        identifier: 'ward-41',
        id: 'ward-41',
        label: 'Ward',
        ward_id: '41'
      })
    ]);

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_COVERAGE_INCOMPLETE'
    });

    expect(renderPack).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
    expect(txRecords.some(({ tx }) => tx.$executeRawUnsafe.mock.calls.length > 0)).toBe(false);
  });

  it('rejects a produced ward whose identifier matches but ward ID differs', async () => {
    featureEnabled = true;
    const policy = makePolicy({
      coverage: {
        wards: [{ wardId: 41, locationIdentifier: 'critical-ward' }],
        paediatricWards: [],
        edBoards: [],
        opdClinicDays: []
      }
    });
    registerPolicy(policy, [
      makePack(policy, {
        type: 'ward',
        identifier: 'critical-ward',
        id: 'critical-ward',
        label: 'Wrong ward',
        ward_id: '42'
      })
    ]);
    const externalSigner = signer();

    await expect(
      generateClinicalContinuityPackSets({ signer: externalSigner })
    ).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_COVERAGE_INCOMPLETE'
    });

    expect(externalSigner.sign).toHaveBeenCalledTimes(1);
    expect(renderPack).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
    expect(txRecords.some(({ tx }) => tx.$executeRawUnsafe.mock.calls.length > 0)).toBe(false);
  });

  it.each([
    'isolation',
    'location',
    'attending',
    'diagnosis',
    'latest_vitals',
    'news2',
    'recent_released_results',
    'care_team'
  ])('blocks a malformed %s context envelope before publication', async field => {
    featureEnabled = true;
    const policy = makePolicy();
    const patient = makePatient('ward');
    patient[field] = { ...patient[field], recorded_at: null };
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage), {
        patients: [patient]
      })
    ]);

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_GENERATION_INVALID'
    });

    expect(renderPack).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
  });

  it('rejects a non-canonical offset safety timestamp before publication', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    const patient = makePatient('ward');
    patient.allergies = {
      ...patient.allergies,
      recorded_at: '2026-07-29T11:30:00+05:30'
    };
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage), {
        patients: [patient]
      })
    ]);

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_GENERATION_INVALID'
    });

    expect(renderPack).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
  });

  it('rejects a signer that does not match the policy before any PHI read', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage))
    ]);
    const invalidSigner = {
      sign: jest.fn(async () => Buffer.alloc(64).toString('base64'))
    };

    await expect(
      generateClinicalContinuityPackSets({ signer: invalidSigner })
    ).rejects.toBeInstanceOf(ClinicalContinuityPackOrchestrationError);

    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
    expect(renderPack).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
  });

  it('rejects a bad pack signature after preflight without publishing evidence', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage))
    ]);
    const externalSigner = signer();
    externalSigner.sign
      .mockImplementationOnce(async ({ keyId, payload }) =>
        cryptoSign(null, payload, privateKeyById.get(keyId)).toString('base64')
      )
      .mockImplementationOnce(async () => Buffer.alloc(64).toString('base64'));

    await expect(
      generateClinicalContinuityPackSets({ signer: externalSigner })
    ).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_SIGNATURE_INVALID'
    });

    expect(produceFacilityPacks).toHaveBeenCalledTimes(1);
    expect(publishPackSet).not.toHaveBeenCalled();
    expect(txRecords.some(({ tx }) => tx.$executeRawUnsafe.mock.calls.length > 0)).toBe(false);
  });

  it('propagates renderer failure without signing or publishing the pack', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage))
    ]);
    renderPack.mockImplementationOnce(() => {
      throw new Error('renderer unavailable');
    });
    const externalSigner = signer();

    await expect(generateClinicalContinuityPackSets({ signer: externalSigner })).rejects.toThrow(
      'renderer unavailable'
    );

    expect(externalSigner.sign).toHaveBeenCalledTimes(1);
    expect(publishPackSet).not.toHaveBeenCalled();
    expect(txRecords.some(({ tx }) => tx.$executeRawUnsafe.mock.calls.length > 0)).toBe(false);
  });

  it('propagates publication failure without writing evidence', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage))
    ]);
    publishPackSet.mockRejectedValueOnce(new Error('publication unavailable'));

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).rejects.toThrow(
      'publication unavailable'
    );

    expect(txRecords.some(({ tx }) => tx.$executeRawUnsafe.mock.calls.length > 0)).toBe(false);
    expect(events.some(event => event.startsWith('pointer:'))).toBe(false);
  });

  it('propagates evidence failure before the current pointer is exposed', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage))
    ]);
    evidenceFailure = new Error('evidence unavailable');

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).rejects.toThrow(
      'evidence unavailable'
    );

    expect(txRecords.some(({ tx }) => tx.$executeRawUnsafe.mock.calls.length === 1)).toBe(true);
    expect(events.some(event => event.startsWith('pointer:'))).toBe(false);
  });

  it('rejects an aged set before any evidence row or current pointer is exposed', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage))
    ]);
    databasePublishedAt = '2026-07-29T06:15:00.001Z';

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_AGED_BEFORE_PUBLICATION'
    });

    expect(publishPackSet).toHaveBeenCalledTimes(1);
    const evidenceTransaction = txRecords.find(
      ({ options }) => options.isolationLevel === undefined
    );
    expect(evidenceTransaction.tx.$executeRawUnsafe).not.toHaveBeenCalled();
    expect(events.some(event => event.startsWith('pointer:'))).toBe(false);
  });

  it('matches normalized publication receipts for uppercase location identifiers', async () => {
    featureEnabled = true;
    const policy = makePolicy({
      coverage: {
        wards: [{ wardId: 41, locationIdentifier: 'WARD-A' }],
        paediatricWards: [],
        edBoards: [],
        opdClinicDays: []
      }
    });
    registerPolicy(policy, [
      makePack(policy, {
        type: 'ward',
        identifier: 'WARD-A',
        id: 'WARD-A',
        label: 'Ward A',
        ward_id: '41'
      })
    ]);

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).resolves.toHaveLength(1);

    const evidenceTransaction = txRecords.find(
      ({ options }) => options.isolationLevel === undefined
    );
    const evidenceArgs = evidenceTransaction.tx.$executeRawUnsafe.mock.calls[0];
    const sourceWatermark = JSON.parse(evidenceArgs[14]);
    expect(sourceWatermark.publication.asset_sha256).toEqual({
      'pack.html': expect.stringMatching(/^[a-f0-9]{64}$/),
      'pack.json': expect.stringMatching(/^[a-f0-9]{64}$/)
    });
  });

  it('remains inert when enabled but no policy is active', async () => {
    featureEnabled = true;

    await expect(generateClinicalContinuityPackSets()).resolves.toEqual([]);

    expect(enumeratePolicies).toHaveBeenCalledTimes(1);
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
  });

  it('requires an operator-injected signer before opening a clinical transaction', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    registerPolicy(policy, [
      makePack(policy, locationForCoverage(policy.policyDocument.requiredCoverage))
    ]);

    await expect(generateClinicalContinuityPackSets()).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_SIGNER_NOT_CONFIGURED'
    });

    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
  });

  it('re-verifies the exact policy in the source transaction before producer reads', async () => {
    featureEnabled = true;
    const discovered = makePolicy();
    const changed = {
      ...discovered,
      id: 'c0000000-0000-4000-8000-000000000003'
    };
    policies.push(discovered);
    policyByFacility.set(`${TENANT_A}/11`, changed);
    producedByFacility.set(
      `${TENANT_A}/11`,
      makeProduced(discovered, [
        makePack(discovered, locationForCoverage(discovered.policyDocument.requiredCoverage))
      ])
    );

    await expect(generateClinicalContinuityPackSets({ signer: signer() })).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_POLICY_CHANGED'
    });

    expect(loadPolicyForFacility).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_A,
        facilityId: 11,
        minimumPolicyVersion: '7',
        minimumRevocationEpoch: '2'
      })
    );
    expect(produceFacilityPacks).not.toHaveBeenCalled();
    expect(publishPackSet).not.toHaveBeenCalled();
  });

  it('rejects duplicate tenant/facility enumeration before signer or clinical reads', async () => {
    featureEnabled = true;
    const policy = makePolicy();
    policies.push(policy, policy);
    const externalSigner = signer();

    await expect(
      generateClinicalContinuityPackSets({ signer: externalSigner })
    ).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_POLICY_AMBIGUOUS'
    });

    expect(externalSigner.sign).not.toHaveBeenCalled();
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
  });

  it('rejects the default tenant before signer or clinical reads', async () => {
    featureEnabled = true;
    const policy = makePolicy({ tenantId: DEFAULT_TENANT_ID });
    policies.push(policy);
    const externalSigner = signer();

    await expect(
      generateClinicalContinuityPackSets({ signer: externalSigner })
    ).rejects.toMatchObject({
      code: 'CONTINUITY_PACK_POLICY_INVALID'
    });

    expect(externalSigner.sign).not.toHaveBeenCalled();
    expect(setTenantTx).not.toHaveBeenCalled();
    expect(produceFacilityPacks).not.toHaveBeenCalled();
  });
});

describe('C3.2a signed-policy source-set purge', () => {
  it('remains inert before policy or filesystem access while the feature flag is false', async () => {
    const policyEnumerator = jest.fn();

    await expect(purgeClinicalContinuitySourceSets({ policyEnumerator }))
      .resolves.toEqual([]);

    expect(policyEnumerator).not.toHaveBeenCalled();
    expect(getPublicationRoot).not.toHaveBeenCalled();
  });

  it('deletes a retention-expired non-current set even before its signed expiry', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'continuity-purge-'));
    try {
      featureEnabled = true;
      const policy = makePolicy({ policySchemaVersion: EDGE_POLICY_SCHEMA_VERSION });
      const paths = buildPublicationPaths({
        root,
        tenantId: policy.tenantId,
        facilityId: policy.facilityId,
        manifestVersion: '1'
      });
      const oldSet = path.join(paths.setsDir, 'v1');
      const currentSet = path.join(paths.setsDir, 'v2');
      await fs.mkdir(oldSet, { recursive: true });
      await fs.mkdir(currentSet, { recursive: true });
      const content = { kind: 'retained-source-manifest' };
      const rendered = canonicalizeJson(content);
      const envelope = createSignedPackEnvelope({
        audience: {
          tenantId: policy.tenantId,
          facilityId: String(policy.facilityId)
        },
        content,
        rendered,
        keyId: policy.currentPackSigningKeyId,
        manifestVersion: '1',
        policyVersion: policy.policyVersion,
        revocationEpoch: policy.revocationEpoch,
        issuedAt: '2026-07-27T00:00:00.000Z',
        expiresAt: '2026-08-01T00:00:00.000Z',
        privateKey: privateKeyById.get(policy.currentPackSigningKeyId)
      });
      await fs.writeFile(
        path.join(oldSet, 'manifest.json'),
        `${canonicalizeJson(envelope)}\n`,
        'utf8'
      );
      await fs.writeFile(
        paths.currentPath,
        JSON.stringify({
          schema: 'continuity-current-v1',
          tenant_id: policy.tenantId,
          facility_id: policy.facilityId,
          manifest_version: '2',
          set: 'sets/v2',
          manifest: 'sets/v2/manifest.json',
          manifest_sha256: 'a'.repeat(64)
        }),
        'utf8'
      );
      getPublicationRoot.mockReturnValueOnce(root);

      await expect(purgeClinicalContinuitySourceSets({
        policyEnumerator: async ({ readOnly }) => {
          expect(readOnly).toBe(true);
          return [policy];
        }
      })).resolves.toEqual([{
        tenantId: policy.tenantId,
        facilityId: policy.facilityId,
        removed: ['v1']
      }]);

      await expect(fs.lstat(oldSet)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.lstat(currentSet)).resolves.toBeDefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a symbolic link anywhere below a purge candidate', async () => {
    const directoryStat = {
      isDirectory: () => true,
      isFile: () => false,
      isSymbolicLink: () => false
    };
    const symlinkStat = {
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true
    };
    const io = {
      lstat: async target => String(target).endsWith('escape') ? symlinkStat : directoryStat,
      readdir: async () => [{
        name: 'escape',
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => true
      }]
    };

    await expect(__testing__.assertPurgeTreeSafe(io, 'C:\\sets\\v1', 'v1'))
      .rejects.toMatchObject({ code: 'CONTINUITY_PACK_PURGE_PATH_UNSAFE' });
  });
});
