import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';

import { jest } from '@jest/globals';

const TENANT = '81000000-0000-4000-8000-000000000001';
const ACTOR = '81000000-0000-4000-8000-000000000002';
const REQUEST = '81000000-0000-4000-8000-000000000003';
const CONTACT = '81000000-0000-4000-8000-000000000004';
const ALLOCATION = '81000000-0000-4000-8000-000000000005';
const INCIDENT = '81000000-0000-4000-8000-000000000006';
const POLICY = '81000000-0000-4000-8000-000000000007';
const packetKeys = generateKeyPairSync('ed25519');
const publicKey = packetKeys.publicKey.export({ type: 'spki', format: 'pem' });

const config = Object.freeze({
  allowedCopyCount: 2,
  clockUncertaintySeconds: 30,
  contactSheetApproverRoles: ['CMO'],
  custodianRoles: ['NURSING_INCHARGE'],
  issuerRoles: ['MEDICAL_SUPERINTENDENT'],
  paperRangePrefix: 'BW-',
  paperRangeSize: 100,
  refreshLeadMinutes: 60,
  signingKeyId: 'incident-packet-k1',
  signingPublicKeySha256: createHash('sha256').update(publicKey, 'utf8').digest('hex'),
  validityMinutes: 720,
});

const policy = Object.freeze({
  id: POLICY,
  policyChecksum: 'a'.repeat(64),
  policyVersion: '9',
  trustedNow: '2026-08-05T10:00:00.000Z',
});

let issuedEvidence;
let voided;

const tx = {
  $executeRawUnsafe: jest.fn(async sql => {
    if (sql.includes('clinical_continuity_void_incident_packet_allocation')) voided = true;
    return 1;
  }),
  $queryRawUnsafe: jest.fn(async (sql, ...params) => {
    if (sql.includes('FROM encryption_keys')) {
      return [{
        id: '71',
        key_id: config.signingKeyId,
        algorithm: 'Ed25519',
        status: 'active',
        metadata: {
          purpose: 'clinical_continuity_incident_packet_signing',
          public_key_spki_pem: publicKey,
        },
      }];
    }
    if (sql.includes('clinical_continuity_allocate_incident_packet')) {
      return [{
        id: ALLOCATION,
        state: 'allocated',
        reserved_incident_id: INCIDENT,
        range_prefix: 'BW-',
        range_first: 101n,
        range_last: 200n,
      }];
    }
    if (sql.includes('clinical_continuity_create_incident_contact_sheet')) {
      return [{ id: CONTACT, version: '3', content_hash: 'b'.repeat(64) }];
    }
    if (sql.includes('SELECT sheet.id::text')) {
      return [{
        id: CONTACT,
        version: '3',
        content_hash: 'b'.repeat(64),
        effective_from: '2026-08-05T09:00:00.000Z',
        effective_until: '2026-08-06T10:00:00.000Z',
        timezone: 'Asia/Kolkata',
        content: {
          schemaVersion: 1,
          source: 'C-D10 drill owner record',
          custodyLocation: 'Continuity cabinet A',
          instructions: 'Call in escalation order and record receipt.',
          contacts: [{
            role: 'NURSING_INCHARGE',
            label: 'Nursing in-charge',
            escalationOrder: 1,
            channels: [
              { kind: 'phone', value: '+910000000001' },
              { kind: 'radio', value: 'Channel 4' },
            ],
          }],
        },
      }];
    }
    if (sql.includes('clinical_continuity_issue_incident_packet')) {
      issuedEvidence = JSON.parse(params[4]);
      return [{
        id: issuedEvidence.packet_id,
        reserved_incident_id: INCIDENT,
        range_prefix: 'BW-',
        range_first: 101n,
        range_last: 200n,
        valid_until: issuedEvidence.valid_until,
        status: 'unused',
      }];
    }
    if (sql.includes('clock_timestamp()::text AS trusted_now')) {
      return [{
        algorithm: 'Ed25519',
        status: 'active',
        metadata: { purpose: 'clinical_continuity_incident_packet_signing' },
        custody_received: true,
        trusted_now: '2026-08-05T10:01:00.000Z',
      }];
    }
    throw new Error(`Unexpected packet SQL: ${sql.slice(0, 120)}`);
  }),
};

jest.unstable_mockModule('../../lib/prisma.js', () => ({
  default: {},
  setTenantTx: jest.fn(async (_tenantId, callback) => callback(tx)),
}));
jest.unstable_mockModule('../../services/downtime/clinicalContinuityPolicyService.js', () => ({
  INCIDENT_PACKET_SIGNING_KEY_PURPOSE: 'clinical_continuity_incident_packet_signing',
  INCIDENT_PACKET_SIGNING_PURPOSE: 'vhhealth/continuity/incident-packet/v1',
  loadActiveClinicalContinuityPolicyForFacilityTx: jest.fn(async () => policy),
  requireClinicalContinuityIncidentPacketPolicy: jest.fn(() => config),
}));
jest.unstable_mockModule('../../services/clinical/canonicalClinicalPlatformService.js', () => ({
  recordClinicalAuditEvent: jest.fn(async () => ({ id: 'packet-audit-1' })),
}));

const {
  createIncidentPacketContactSheet,
  provisionIncidentPacket,
  verifyProvisionedIncidentPacketTx,
} = await import('../../services/downtime/clinicalContinuityIncidentPacketProvisioningService.js');

const validContactContent = {
  schemaVersion: 1,
  source: 'C-D10 drill owner record',
  custodyLocation: 'Continuity cabinet A',
  instructions: 'Call in escalation order and record receipt.',
  contacts: [{
    role: 'NURSING_INCHARGE',
    label: 'Nursing in-charge',
    escalationOrder: 1,
    channels: [
      { kind: 'phone', value: '+910000000001' },
      { kind: 'radio', value: 'Channel 4' },
    ],
  }],
};

function signer() {
  return {
    sign: jest.fn(async ({ algorithm, keyId, payload, purpose }) => {
      expect(algorithm).toBe('Ed25519');
      expect(keyId).toBe(config.signingKeyId);
      expect(purpose).toBe('vhhealth/continuity/incident-packet/v1');
      return cryptoSign(null, payload, packetKeys.privateKey).toString('base64');
    }),
  };
}

beforeEach(() => {
  issuedEvidence = null;
  voided = false;
  jest.clearAllMocks();
});

test('contact sheets require the closed no-patient-data phone-tree shape and independent channels', async () => {
  await expect(createIncidentPacketContactSheet({
    tenantId: TENANT,
    facilityId: 17,
    actorUid: ACTOR,
    actorRole: 'MEDICAL_SUPERINTENDENT',
    content: {
      ...validContactContent,
      patientUid: 'forbidden',
    },
  })).rejects.toMatchObject({ code: 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID' });
  await expect(createIncidentPacketContactSheet({
    tenantId: TENANT,
    facilityId: 17,
    actorUid: ACTOR,
    actorRole: 'MEDICAL_SUPERINTENDENT',
    content: {
      ...validContactContent,
      contacts: [{
        ...validContactContent.contacts[0],
        channels: [{ kind: 'phone', value: '+910000000001' }],
      }],
    },
  })).rejects.toMatchObject({ code: 'CONTINUITY_INCIDENT_PACKET_INPUT_INVALID' });
  await expect(createIncidentPacketContactSheet({
    tenantId: TENANT,
    facilityId: 17,
    actorUid: ACTOR,
    actorRole: 'MEDICAL_SUPERINTENDENT',
    content: validContactContent,
  })).resolves.toMatchObject({ contact_sheet: { id: CONTACT } });
});

test('server mints identity/range/times, locally verifies Ed25519, and renders visible expiry', async () => {
  const externalSigner = signer();
  const result = await provisionIncidentPacket({
    tenantId: TENANT,
    facilityId: 17,
    actorUid: ACTOR,
    actorRole: 'MEDICAL_SUPERINTENDENT',
    contactSheetId: CONTACT,
    requestId: REQUEST,
    signer: externalSigner,
  });

  expect(result.disposition).toBe('issued');
  expect(externalSigner.sign).toHaveBeenCalledTimes(1);
  expect(issuedEvidence.canonical_payload).toMatchObject({
    allowedCopyCount: 2,
    facilityId: 17,
    facilityTimezone: 'Asia/Kolkata',
    purpose: 'vhhealth/continuity/incident-packet/v1',
    range: { first: '101', last: '200', prefix: 'BW-' },
    reservedIncidentId: INCIDENT,
    tenantId: TENANT,
  });
  expect(issuedEvidence.canonical_payload.packetId).toBe(issuedEvidence.packet_id);
  expect(issuedEvidence.valid_from).toBe('2026-08-05T10:00:00.000Z');
  expect(issuedEvidence.valid_until).toBe('2026-08-05T22:00:00.000Z');
  expect(issuedEvidence.authorization_audit_id).toBe('packet-audit-1');
  const artifact = Buffer.from(issuedEvidence.artifact_base64, 'base64').toString('utf8');
  expect(artifact).toContain('NOT VALID AFTER: 2026-08-05T22:00:00.000Z');
  expect(artifact).toContain('USE ONCE');
  expect(artifact).toContain('C-D10 PHONE TREE / ROLE CONTACT SHEET');
  expect(artifact).toContain('MACHINE-READABLE SIGNED ENVELOPE');
  expect(artifact).toContain('This packet contains no patient data');
  expect(voided).toBe(false);
});

test('fails closed and permanently voids the reserved range when signer evidence is forged', async () => {
  await expect(provisionIncidentPacket({
    tenantId: TENANT,
    facilityId: 17,
    actorUid: ACTOR,
    actorRole: 'MEDICAL_SUPERINTENDENT',
    contactSheetId: CONTACT,
    requestId: REQUEST,
    signer: { sign: jest.fn(async () => Buffer.alloc(64, 0x42).toString('base64')) },
  })).rejects.toMatchObject({ code: 'CONTINUITY_INCIDENT_PACKET_SIGNATURE_INVALID' });
  expect(voided).toBe(true);
  expect(issuedEvidence).toBeNull();
});

test('declaration verification rejects a canonical-payload or signature forgery', async () => {
  await provisionIncidentPacket({
    tenantId: TENANT,
    facilityId: 17,
    actorUid: ACTOR,
    actorRole: 'MEDICAL_SUPERINTENDENT',
    contactSheetId: CONTACT,
    requestId: REQUEST,
    signer: signer(),
  });
  const packetRow = {
    id: issuedEvidence.packet_id,
    tenant_id: TENANT,
    facility_id: 17,
    packet_schema_version: 1,
    canonical_payload: issuedEvidence.canonical_payload,
    canonical_payload_jcs: issuedEvidence.canonical_payload_jcs,
    canonical_payload_hash: issuedEvidence.canonical_payload_hash,
    signature: issuedEvidence.signature,
    signing_public_key_spki_pem: publicKey,
    signing_public_key_sha256: config.signingPublicKeySha256,
    clock_uncertainty_seconds: 30,
    valid_from: issuedEvidence.valid_from,
    valid_until: issuedEvidence.valid_until,
  };
  await expect(verifyProvisionedIncidentPacketTx(tx, packetRow)).resolves.toBeUndefined();
  await expect(verifyProvisionedIncidentPacketTx(tx, {
    ...packetRow,
    canonical_payload: { ...packetRow.canonical_payload, allowedCopyCount: 99 },
  })).rejects.toMatchObject({ code: 'CONTINUITY_PACKET_INVALID' });
});
