import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CLINICAL_CONTINUITY_ACTION_CATALOG } from '../../config/clinicalContinuityActionCatalog.js';
import {
  canonicalizeJson,
  createSignedPackEnvelope,
  hashCanonicalValue,
  sha256Hex,
} from '../../services/downtime/continuityPackCanonical.js';
import { produceFacilityContinuityPacks } from '../../services/downtime/continuityPackProducers.js';
import { publishContinuityPackSet } from '../../services/downtime/continuityPackPublicationService.js';
import { buildContinuityPackHtml } from '../../services/downtime/continuityPackRenderer.js';

const TENANT_ID = '52e31913-c846-4458-a21b-31cd2f457e9b';
const FACILITY_ID = 41;
const POLICY_ID = '55555555-5555-4555-8555-555555555555';
const PUBLICATION_SET_ID = '66666666-6666-4666-8666-666666666666';
const STAFF_ID = '22222222-2222-4222-8222-222222222222';
const DEVICE_ID = 'staff-device-1';
const GRANT_ID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = 'continuity-fixture-current-k1';
const GENERATED_AT = '2026-07-29T06:00:00.000Z';
const TRUSTED_NOW = '2026-07-29T06:01:00.000Z';
const FRESH_UNTIL = '2026-07-29T06:15:00.000Z';
const EXPIRES_AT = '2026-07-30T06:00:00.000Z';
const MANIFEST_VERSION = '9';
const POLICY_VERSION = '7';
const REVOCATION_EPOCH = '3';
const LOCATION_ID = 'ward-8';
const POLICY_DELIVERY_FORMAT = 'vhhealth_clinical_continuity_policy_delivery/v1';
const POLICY_DELIVERY_MEDIA_TYPE =
  'application/vnd.vhhealth.clinical-continuity-policy+json';
const FIXTURE_FORMAT = 'vhhealth_continuity_compatibility_fixture/v1';
const FIXTURE_NAMES = Object.freeze([
  'v1_valid',
  'v2_valid',
  'v1_masquerading_v2',
  'v2_missing_delivery',
]);

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const FIXTURE_SEED = Buffer.from(
  '8acaf7137b62f05acb80a9440e8fa2d8c06fddce78ec062afe7cc9fa653fe7de',
  'hex',
);
const PRIVATE_KEY = createPrivateKey({
  format: 'der',
  key: Buffer.concat([PKCS8_ED25519_PREFIX, FIXTURE_SEED]),
  type: 'pkcs8',
});
const PUBLIC_KEY = createPublicKey(PRIVATE_KEY);
const PUBLIC_KEY_PEM = PUBLIC_KEY.export({ format: 'pem', type: 'spki' }).toString();
const PUBLIC_KEY_SHA256 = createHash('sha256').update(PUBLIC_KEY_PEM).digest('hex');

const APPROVAL_EVIDENCE = Object.freeze({
  countersignedAt: '2026-07-30',
  decisionId: 'C-D3',
  source: 'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix',
});

function deepClone(value) {
  return JSON.parse(canonicalizeJson(value));
}

function signBytes(bytes) {
  return cryptoSign(null, Buffer.from(bytes), PRIVATE_KEY).toString('base64');
}

function signedEnvelope(content, rendered) {
  return createSignedPackEnvelope({
    audience: { facilityId: String(FACILITY_ID), tenantId: TENANT_ID },
    content,
    expiresAt: EXPIRES_AT,
    issuedAt: GENERATED_AT,
    keyId: KEY_ID,
    manifestVersion: MANIFEST_VERSION,
    policyVersion: POLICY_VERSION,
    privateKey: PRIVATE_KEY,
    rendered,
    revocationEpoch: REVOCATION_EPOCH,
  });
}

function actionRegistry() {
  const projection = {
    actions: deepClone(CLINICAL_CONTINUITY_ACTION_CATALOG),
    activation: {
      enforcedActionIds: [
        'emr.nursing_note.draft.store',
        'emr.op_note.draft.store',
      ],
      mode: 'enforce',
    },
    approvalEvidence: APPROVAL_EVIDENCE,
    audience: { devicePostures: ['desktop', 'tablet'] },
    compatibilityRules: [],
    expiresAt: EXPIRES_AT,
    issuedAt: GENERATED_AT,
    minimumAppVersions: { desktop: '1.2.0', tablet: '1.2.0' },
    registrySchemaVersion: 1,
    registryVersion: '5',
  };
  return {
    ...projection,
    registryChecksum: hashCanonicalValue(projection),
  };
}

function policyDocument(packSchemaVersion) {
  const document = {
    audience: { facilityId: String(FACILITY_ID), tenantId: TENANT_ID },
    edgeAccess: {
      authenticationMode: 'mtls_client_certificate',
      credentialLifetimeMinutes: 720,
      emergencyReadPosture: 'disabled',
      maximumOfflineAuthorizationMinutes: 37,
    },
    fieldPolicy: {
      allergyUnknownText: 'Allergy status UNKNOWN — not recorded',
      bloodGroupIncluded: false,
      codeStatusUnknownText: 'Code status NOT RECORDED — confirm per hospital policy',
      contextFields: [
        'bedLocation',
        'attendingDoctor',
        'diagnosisOrChiefComplaint',
        'latestVitals',
        'news2',
        'recentReleasedResults',
        'careTeam',
      ],
      isolationSource: 'structured_only',
      opdDestroyAfterClinicDay: true,
      paediatricWeightRequired: true,
      recentlyAdministeredLookbackHours: 12,
      safetyFieldRecordedAtRequired: true,
      safetyFields: [
        'identity.name',
        'identity.mrnOrUid',
        'identity.dateOfBirth',
        'allergies',
        'codeStatus',
        'medicationsDue',
        'activeMedicationOrders',
        'recentlyAdministeredMedications',
        'unresolvedCriticalResults',
      ],
    },
    generation: {
      hardExpiryHours: 24,
      historicalMode: false,
      intervalMinutes: 15,
    },
    includedAreas: { ed: false, opd: false, paediatrics: false, wards: true },
    medicationsDueWindow: { lookaheadHours: 12, lookbackHours: 1 },
    packSchemaVersion,
    policySchemaVersion: packSchemaVersion === 2 ? 3 : 1,
    policyType: 'clinical_continuity_pack',
    recentReleasedResults: {
      itemCodeAllowlist: ['718-7', 'HR'],
      lookbackHours: 72,
      maxPerPatient: 20,
      portalReleaseDelayHours: 24,
    },
    requiredCoverage: {
      edBoards: [],
      opdClinicDays: [],
      paediatricWards: [],
      wards: [{ label: 'Ward 8', locationIdentifier: LOCATION_ID, wardId: 8 }],
    },
    retention: {
      recoveredLogReceiptHours: 8760,
      sourcePackRetentionHours: 24,
    },
  };
  if (packSchemaVersion === 2) document.actionRegistry = actionRegistry();
  return document;
}

function policyDelivery() {
  const document = policyDocument(2);
  const registry = document.actionRegistry;
  const payload = {
    actionRegistryChecksum: registry.registryChecksum,
    actionRegistrySchemaVersion: registry.registrySchemaVersion,
    actionRegistryVersion: registry.registryVersion,
    algorithm: 'Ed25519',
    audience: { facilityId: String(FACILITY_ID), tenantId: TENANT_ID },
    canonicalization: 'rfc8785-jcs',
    currentPackSigningKeyId: KEY_ID,
    currentPackSigningPublicKeySha256: PUBLIC_KEY_SHA256,
    effectiveFrom: GENERATED_AT,
    effectiveUntil: EXPIRES_AT,
    nextPackSigningKeyId: null,
    nextPackSigningPublicKeySha256: null,
    policyChecksum: hashCanonicalValue(document),
    policyDocument: document,
    policySchemaVersion: 3,
    policySigningKeyId: KEY_ID,
    policySigningPublicKeySha256: PUBLIC_KEY_SHA256,
    policyVersion: POLICY_VERSION,
    revocationEpoch: REVOCATION_EPOCH,
    revokedKeyIds: [],
    supersedesPolicyId: null,
  };
  const envelope = {
    format: POLICY_DELIVERY_FORMAT,
    payload,
    policyId: POLICY_ID,
    signature: signBytes(Buffer.from(canonicalizeJson(payload), 'utf8')),
  };
  const canonicalBody = canonicalizeJson(envelope);
  return {
    canonicalBody,
    envelope,
    envelopeFormat: POLICY_DELIVERY_FORMAT,
    envelopeSha256: sha256Hex(Buffer.from(canonicalBody, 'utf8')),
    mediaType: POLICY_DELIVERY_MEDIA_TYPE,
    policyChecksum: payload.policyChecksum,
  };
}

function producerPolicy(packSchemaVersion, delivery) {
  const document = packSchemaVersion === 2
    ? delivery.envelope.payload.policyDocument
    : policyDocument(1);
  return {
    id: POLICY_ID,
    policyChecksum: hashCanonicalValue(document),
    policyDelivery: packSchemaVersion === 2 ? delivery : null,
    policyDocument: document,
    policyVersion: POLICY_VERSION,
    revocationEpoch: REVOCATION_EPOCH,
  };
}

function fakeTx() {
  return {
    async $queryRawUnsafe(sql) {
      const marker = /\/\* continuity:([a-z0-9-]+) \*\//i.exec(sql)?.[1];
      if (marker === 'watermark') {
        return [{
          captured_at: new Date(GENERATED_AT),
          transaction_id: 100n,
          transaction_isolation: 'repeatable read',
          txid_snapshot: '100:100:',
        }];
      }
      if (marker === 'facility') {
        return [{
          display_name: 'VH Central',
          facility_code: 'VHC',
          id: FACILITY_ID,
          status: 'active',
          tenant_id: TENANT_ID,
          timezone: 'Asia/Kolkata',
        }];
      }
      if (marker === 'ward-definition') {
        return [{
          department_name: 'Medicine',
          facility_id: FACILITY_ID,
          floor: 1,
          id: 8,
          name: 'Ward 8',
          updated_at: new Date(GENERATED_AT),
        }];
      }
      if (marker === 'ward-census') return [];
      throw new Error(`Unexpected fixture producer query: ${marker ?? 'unmarked'}`);
    },
  };
}

async function producedPack(packSchemaVersion, delivery) {
  const produced = await produceFacilityContinuityPacks({
    facilityId: FACILITY_ID,
    policy: producerPolicy(packSchemaVersion, delivery),
    tenantId: TENANT_ID,
    tx: fakeTx(),
  });
  if (produced.packs.length !== 1) {
    throw new Error('Fixture producer must emit exactly one ward pack');
  }
  return deepClone(produced.packs[0]);
}

function edgeAccessContent() {
  return {
    accessRevision: '11',
    audience: { facilityId: String(FACILITY_ID), tenantId: TENANT_ID },
    edgeAccess: {
      authenticationMode: 'mtls_client_certificate',
      credentialLifetimeMinutes: 720,
      emergencyReadPosture: 'disabled',
      maximumOfflineAuthorizationMinutes: 37,
    },
    format: 'vhhealth_continuity_edge_access/v1',
    generatedAt: GENERATED_AT,
    grants: [{
      accessRevision: '11',
      clientCertificateSha256: 'a'.repeat(64),
      deviceId: DEVICE_ID,
      grantId: GRANT_ID,
      locationIdentifier: LOCATION_ID,
      locationType: 'ward',
      staffUid: STAFF_ID,
      validFrom: GENERATED_AT,
      validUntil: '2026-07-29T10:00:00.000Z',
    }],
    policy: {
      id: POLICY_ID,
      revocationEpoch: REVOCATION_EPOCH,
      version: POLICY_VERSION,
    },
    revocations: [],
  };
}

function trustBundle() {
  const key = {
    algorithm: 'Ed25519',
    keyId: KEY_ID,
    publicKeySha256: PUBLIC_KEY_SHA256,
    publicKeySpkiPem: PUBLIC_KEY_PEM,
  };
  return {
    algorithm: 'Ed25519',
    audience: { facilityId: String(FACILITY_ID), tenantId: TENANT_ID },
    distribution: 'operator_provisioned_out_of_band',
    format: 'vhhealth_clinical_continuity_trust/v1',
    minimumPolicyVersion: POLICY_VERSION,
    minimumRevocationEpoch: REVOCATION_EPOCH,
    packSigningKeys: [{ ...key, state: 'current' }],
    policySigningKey: key,
    refusalPolicy: {
      compromisedOrRevokedKey: 'reject_pack_use_paper_and_phone',
      uncertainClock: 'refuse_as_current_use_paper_and_phone',
      versionRollback: 'reject_pack_use_paper_and_phone',
    },
    revocationEpoch: REVOCATION_EPOCH,
    revokedKeyIds: [],
  };
}

function fixtureExpectations(name) {
  switch (name) {
    case 'v1_valid':
      return { baselineDecision: 'accepted', upgradedDecision: 'accepted' };
    case 'v2_valid':
      return { baselineDecision: 'coverage_mismatch', upgradedDecision: 'accepted' };
    case 'v1_masquerading_v2':
    case 'v2_missing_delivery':
      return { baselineDecision: 'coverage_mismatch', upgradedDecision: 'coverage_mismatch' };
    default:
      throw new Error(`Unknown fixture ${name}`);
  }
}

async function buildFixture(name, root, delivery) {
  const packSchemaVersion = name.startsWith('v2_') ? 2 : 1;
  const pack = await producedPack(packSchemaVersion, delivery);
  let manifestPolicyChecksum = packSchemaVersion === 2
    ? delivery.policyChecksum
    : hashCanonicalValue(policyDocument(1));
  if (name === 'v1_masquerading_v2') {
    pack.policy = {
      checksum: delivery.policyChecksum,
      delivery: {
        envelope_base64: Buffer.from(delivery.canonicalBody, 'utf8').toString('base64'),
        envelope_format: delivery.envelopeFormat,
        envelope_sha256: delivery.envelopeSha256,
        media_type: delivery.mediaType,
      },
      id: POLICY_ID,
      revocation_epoch: REVOCATION_EPOCH,
      version: POLICY_VERSION,
    };
    manifestPolicyChecksum = delivery.policyChecksum;
  } else if (name === 'v2_missing_delivery') {
    delete pack.policy.delivery;
  }

  const html = buildContinuityPackHtml(pack, {
    clockTrusted: true,
    freshness: {
      fallback: { paper: false, phone: false },
      packAccess: { display: true, print: true },
      reason: null,
      state: 'CURRENT',
    },
    trustedNow: GENERATED_AT,
  });
  const packEnvelope = signedEnvelope(pack, html);
  const packJson = `${canonicalizeJson(packEnvelope)}\n`;

  const edgeContent = edgeAccessContent();
  const edgeRendered = canonicalizeJson(edgeContent);
  const edgeEnvelope = signedEnvelope(edgeContent, edgeRendered);
  const edgeJson = `${canonicalizeJson(edgeEnvelope)}\n`;

  const manifest = {
    edgeAccess: {
      accessRevision: '11',
      path: 'edge-access.json',
      sha256: sha256Hex(edgeJson),
    },
    facility: { id: String(FACILITY_ID), name: 'VH Central', timezone: 'Asia/Kolkata' },
    format: 'vhhealth_clinical_continuity_manifest/v1',
    generatedAt: GENERATED_AT,
    locations: [{
      contentHash: packEnvelope.contentHash,
      expiresAt: EXPIRES_AT,
      generatedAt: GENERATED_AT,
      keyId: KEY_ID,
      locationId: LOCATION_ID,
      locationType: 'ward',
      packHtmlSha256: sha256Hex(html),
      packJsonSha256: sha256Hex(packJson),
      renderHash: packEnvelope.renderHash,
    }],
    manifestVersion: MANIFEST_VERSION,
    policy: {
      checksum: manifestPolicyChecksum,
      id: POLICY_ID,
      revocationEpoch: REVOCATION_EPOCH,
      version: POLICY_VERSION,
    },
    publicationSetId: PUBLICATION_SET_ID,
    sourceWatermark: pack.source_watermark,
    tenantId: TENANT_ID,
  };
  const manifestRendered = canonicalizeJson(manifest);
  const manifestEnvelope = signedEnvelope(manifest, manifestRendered);
  const manifestJson = `${canonicalizeJson(manifestEnvelope)}\n`;

  const publication = await publishContinuityPackSet({
    assets: [
      { content: packJson, locationId: LOCATION_ID, locationType: 'ward', relativePath: 'pack.json' },
      { content: html, locationId: LOCATION_ID, locationType: 'ward', relativePath: 'pack.html' },
    ],
    facilityId: FACILITY_ID,
    manifestContent: manifestJson,
    manifestVersion: MANIFEST_VERSION,
    requiredCoverage: [{ locationId: LOCATION_ID, locationType: 'ward' }],
    root,
    rootAssets: [{ content: edgeJson, relativePath: 'edge-access.json' }],
    tenantId: TENANT_ID,
  });
  const published = publication.paths.setDir;
  const [publishedManifest, publishedEdge, publishedPack, publishedHtml] = await Promise.all([
    fs.readFile(path.join(published, 'manifest.json')),
    fs.readFile(path.join(published, 'edge-access.json')),
    fs.readFile(path.join(published, 'locations', 'ward', LOCATION_ID, 'pack.json')),
    fs.readFile(path.join(published, 'locations', 'ward', LOCATION_ID, 'pack.html')),
  ]);

  return {
    expected: fixtureExpectations(name),
    fixtureFormat: FIXTURE_FORMAT,
    generator: {
      producer: 'produceFacilityContinuityPacks',
      publication: 'publishContinuityPackSet',
      signing: 'createSignedPackEnvelope',
    },
    name,
    snapshot: {
      assets: [
        {
          contentBase64: publishedEdge.toString('base64'),
          path: 'edge-access.json',
        },
        {
          contentBase64: publishedHtml.toString('base64'),
          path: `locations/ward/${LOCATION_ID}/pack.html`,
        },
        {
          contentBase64: publishedPack.toString('base64'),
          path: `locations/ward/${LOCATION_ID}/pack.json`,
        },
      ],
      clock: {
        minimumTrustedNow: GENERATED_AT,
        trusted: true,
        trustedNow: TRUSTED_NOW,
      },
      manifestEnvelopeBase64: publishedManifest.toString('base64'),
      provenance: {
        accessRevision: '11',
        sourceRevision: 'fixture-source-1',
        sourceWatermark: 'backend-publication-readback',
      },
      session: {
        authenticatedAt: GENERATED_AT,
        deviceId: DEVICE_ID,
        facilityId: String(FACILITY_ID),
        role: 'nurse',
        staffId: STAFF_ID,
        tenantId: TENANT_ID,
      },
      trustBundle: trustBundle(),
    },
  };
}

export async function generateClinicalContinuityPolicyDeliveryFixtures() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vh-continuity-fixtures-'));
  try {
    const delivery = policyDelivery();
    const entries = await Promise.all(FIXTURE_NAMES.map(async name => [
      name,
      await buildFixture(name, path.join(temporaryRoot, name), delivery),
    ]));
    return Object.fromEntries(entries);
  } finally {
    await fs.rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function readClinicalContinuityPolicyDeliveryFixtures(root) {
  const entries = await Promise.all(FIXTURE_NAMES.map(async name => [
    name,
    JSON.parse(await fs.readFile(path.join(root, `${name}.snapshot.json`), 'utf8')),
  ]));
  return Object.fromEntries(entries);
}

export async function writeClinicalContinuityPolicyDeliveryFixtures(root) {
  const fixtures = await generateClinicalContinuityPolicyDeliveryFixtures();
  await fs.mkdir(root, { recursive: true });
  await Promise.all(Object.entries(fixtures).map(([name, fixture]) =>
    fs.writeFile(path.join(root, `${name}.snapshot.json`), `${JSON.stringify(fixture, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    })));
  return fixtures;
}

export const CLINICAL_CONTINUITY_POLICY_DELIVERY_FIXTURE_NAMES = FIXTURE_NAMES;
