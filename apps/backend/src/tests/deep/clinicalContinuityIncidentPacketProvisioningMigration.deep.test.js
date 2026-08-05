import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
} from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

import { canonicalizeJson } from '../../services/downtime/continuityPackCanonical.js';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/630_clinical_continuity_incident_packet_provisioning.sql', import.meta.url),
  'utf8',
);
const RAW_ROLE = 'c52_packet_forgery_test';
const packetKeys = generateKeyPairSync('ed25519');
const packetPublicKey = packetKeys.publicKey.export({ type: 'spki', format: 'pem' });

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function testPublicKey(label) {
  return [
    '-----BEGIN PUBLIC KEY-----',
    Buffer.from(label, 'utf8').toString('base64'),
    '-----END PUBLIC KEY-----',
  ].join('\n');
}

function activePolicyDocument({ tenantId, facilityId, effectiveFrom, effectiveUntil, packetKeyId }) {
  const registryChecksum = 'c'.repeat(64);
  return {
    policySchemaVersion: 4,
    audience: { tenantId, facilityId: String(facilityId) },
    actionRegistry: {
      actions: Array.from({ length: 17 }, (_, index) => ({ actionId: `packet.test.${index}` })),
      activation: { enforcedActionIds: [], mode: 'shadow' },
      approvalEvidence: {
        countersignedAt: '2026-07-30',
        decisionId: 'C-D3',
        source: 'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix',
      },
      audience: { devicePostures: ['desktop'] },
      compatibilityRules: [],
      expiresAt: effectiveUntil.toISOString(),
      issuedAt: effectiveFrom.toISOString(),
      minimumAppVersions: { desktop: '1.0.0', tablet: '1.0.0' },
      registryChecksum,
      registrySchemaVersion: 1,
      registryVersion: '1',
    },
    incidentPacketProvisioning: {
      schemaVersion: 1,
      purpose: 'vhhealth/continuity/incident-packet/v1',
      issuerCapability: 'continuity_incident_packet_issue',
      custodianCapability: 'continuity_incident_packet_custody',
      issuerRoles: ['MEDICAL_SUPERINTENDENT'],
      custodianRoles: ['NURSING_INCHARGE'],
      contactSheetApproverRoles: ['CMO'],
      signingKeyId: packetKeyId,
      signingPublicKeySha256: sha256(Buffer.from(packetPublicKey, 'utf8')),
      validityMinutes: 720,
      refreshLeadMinutes: 60,
      clockUncertaintySeconds: 30,
      paperRangePrefix: 'BW-RAW-',
      paperRangeSize: 100,
      allowedCopyCount: 2,
    },
  };
}

async function capturedFailure(client, operation) {
  await client.query('SAVEPOINT expected_packet_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_packet_failure');
  await client.query('RELEASE SAVEPOINT expected_packet_failure');
  expect(failure).toBeDefined();
  return failure;
}

describe('migration 630 static incident-packet authority', () => {
  test('owns the fresh slot and seeds no policy, contact, key, range, role, or packet', () => {
    expect(readdirSync(new URL('../../migrations/', import.meta.url))
      .filter(name => name.startsWith('630_')))
      .toEqual(['630_clinical_continuity_incident_packet_provisioning.sql']);
    expect(migrationSql).not.toMatch(/INSERT INTO public\.clinical_continuity_policy_versions/i);
    expect(migrationSql).not.toMatch(/INSERT INTO public\.encryption_keys/i);
    expect(migrationSql).not.toMatch(/CREATE ROLE/i);
  });

  test('makes guarded issuance the only runtime INSERT and pins all cryptographic evidence', () => {
    expect(migrationSql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.clinical_continuity_incident_packets');
    expect(migrationSql).toContain('clinical_continuity_issue_incident_packet');
    expect(migrationSql).toContain("key_record.algorithm <> 'Ed25519'");
    expect(migrationSql).toContain("key_record.metadata ->> 'purpose'");
    expect(migrationSql).toContain("digest(convert_to(p_packet ->> 'canonical_payload_jcs'");
    expect(migrationSql).toContain("p_packet ->> 'signature' !~");
    expect(migrationSql).toContain('signing_public_key_spki_pem');
    expect(migrationSql).toContain('packet_schema_version = 1');
    expect(migrationSql).toContain('chk_cc_packet_authenticated_actor');
    expect(migrationSql).toContain('authorization_audit_id');
    expect(migrationSql).toContain('clinical_continuity.incident_packet.issue_authorized');
  });

  test('uses FORCE RLS, append-only custody, disjoint ranges, and exclusive expiry', () => {
    expect(migrationSql).toContain('FORCE ROW LEVEL SECURITY');
    expect(migrationSql).toContain(
      'ALTER TABLE public.clinical_continuity_incident_packets FORCE ROW LEVEL SECURITY',
    );
    expect(migrationSql).toContain('AS RESTRICTIVE');
    expect(migrationSql).toContain('EXCLUDE USING gist');
    expect(migrationSql).not.toContain("WHERE (state IN ('allocated', 'issued'))");
    expect(migrationSql).toContain('chk_cc_packet_evidence_append_only');
    expect(migrationSql).toContain('clock_timestamp() + make_interval');
    expect(migrationSql).toContain('>= packet.valid_until');
    expect(migrationSql).toContain('replacement custody received');
  });
});

describeIfDb('migration 630 raw-pg incident-packet forgery negatives', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const actorUid = randomUUID();
  const approverUid = randomUUID();
  const packetId = randomUUID();
  const reservedIncidentId = randomUUID();
  const requestId = randomUUID();
  const requestFingerprint = 'e'.repeat(64);
  const facilityId = 1900000000 + Math.floor(Math.random() * 1000000);
  const policyKeyId = `packet-policy-${randomUUID()}`;
  const packKeyId = `packet-pack-${randomUUID()}`;
  const packetKeyId = `packet-signing-${randomUUID()}`;
  const policyChecksum = 'd'.repeat(64);
  let policyId;
  let packetKeyVersion;
  let contactSheet;
  let allocation;

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RAW_ROLE}') THEN
          CREATE ROLE ${RAW_ROLE} NOLOGIN;
        END IF;
      END $$
    `);
    await client.query(`GRANT USAGE ON SCHEMA public TO ${RAW_ROLE}`);
    await client.query(
      `GRANT EXECUTE ON FUNCTION public.clinical_continuity_issue_incident_packet(
         UUID, INTEGER, UUID, TEXT, JSONB
       ) TO ${RAW_ROLE}`,
    );
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C5.2 packet raw forgery test')`,
      [tenantId, `c52-packet-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO facilities (id, tenant_id, facility_code, display_name, timezone)
       VALUES ($1::integer, $2::uuid, $3::text, 'C5.2 packet raw test', 'Asia/Kolkata')`,
      [facilityId, tenantId, `C52-${randomUUID()}`],
    );
    for (const [uid, role, phone] of [
      [actorUid, 'MEDICAL_SUPERINTENDENT', `+9181${String(facilityId).slice(-8)}`],
      [approverUid, 'CMO', `+9182${String(facilityId).slice(-8)}`],
    ]) {
      await client.query(
        `INSERT INTO users (
           uid, tenant_id, phone, name, role, is_active, status,
           is_deleted, registered_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::text, 'C5.2 packet raw actor', $4::text,
           TRUE, 'active', FALSE, NOW(), NOW()
         )`,
        [uid, tenantId, phone, role],
      );
    }
    const keyFixtures = [
      [policyKeyId, 'clinical_continuity_policy_signing', testPublicKey(policyKeyId)],
      [packKeyId, 'clinical_continuity_pack_signing', testPublicKey(packKeyId)],
      [packetKeyId, 'clinical_continuity_incident_packet_signing', packetPublicKey],
    ];
    for (const [keyId, purpose, publicKey] of keyFixtures) {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
      const inserted = await client.query(
        `INSERT INTO encryption_keys (
           tenant_id, key_id, provider, algorithm, status, metadata
         ) VALUES (
           $1::uuid, $2::text, 'env', 'Ed25519', 'active',
           jsonb_build_object('purpose', $3::text, 'public_key_spki_pem', $4::text)
         ) RETURNING id::text`,
        [tenantId, keyId, purpose, publicKey],
      );
      if (keyId === packetKeyId) packetKeyVersion = inserted.rows[0].id;
    }
    const effectiveFrom = new Date(Date.now() - 60 * 60 * 1000);
    const effectiveUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const policyDocument = activePolicyDocument({
      tenantId,
      facilityId,
      effectiveFrom,
      effectiveUntil,
      packetKeyId,
    });
    const insertedPolicy = await client.query(
      `INSERT INTO clinical_continuity_policy_versions (
         tenant_id, facility_id, policy_version, policy_schema_version,
         action_registry_schema_version, action_registry_version,
         action_registry_checksum, policy_document, policy_checksum,
         policy_signing_key_id, policy_signing_public_key_sha256,
         current_pack_signing_key_id, current_pack_signing_public_key_sha256,
         policy_signature, effective_from, effective_until
       ) VALUES (
         $1::uuid, $2::integer, 1, 4, 1, 1, $3::char(64), $4::jsonb,
         $5::char(64), $6::text, $7::char(64), $8::text, $9::char(64),
         $10::bytea, $11::timestamptz, $12::timestamptz
       ) RETURNING id::text`,
      [
        tenantId,
        facilityId,
        'c'.repeat(64),
        JSON.stringify(policyDocument),
        policyChecksum,
        policyKeyId,
        sha256(Buffer.from(testPublicKey(policyKeyId), 'utf8')),
        packKeyId,
        sha256(Buffer.from(testPublicKey(packKeyId), 'utf8')),
        Buffer.alloc(64, 0x42),
        effectiveFrom,
        effectiveUntil,
      ],
    );
    policyId = insertedPolicy.rows[0].id;
    const decidedAt = new Date();
    const approval = await client.query(
      `INSERT INTO approvals (
         tenant_id, approval_kind, subject_resource_type, subject_resource_id,
         required_approvers, status, approved_by, decided_at, created_by,
         decided_by, metadata
       ) VALUES (
         $1::uuid, 'clinical_continuity_policy_governance',
         'clinical_continuity_policy_version', $2::text, 1, 'approved',
         $3::jsonb, $4::timestamptz, $5::uuid, $5::uuid, $6::jsonb
       ) RETURNING id`,
      [
        tenantId,
        policyId,
        JSON.stringify([{ uid: actorUid, at: new Date(decidedAt.getTime() - 1000).toISOString() }]),
        decidedAt,
        actorUid,
        JSON.stringify({
          clinical_continuity_policy_governance: {
            policy_checksum: policyChecksum,
            countersignature_complete: true,
            action_registry_schema_version: 1,
            action_registry_version: 1,
            action_registry_checksum: 'c'.repeat(64),
            action_registry_decision_id: 'C-D3',
          },
        }),
      ],
    );
    await client.query(
      `UPDATE clinical_continuity_policy_versions
          SET lifecycle_state = 'approved', approval_id = $1::integer,
              approved_by = $2::uuid, approved_at = $3::timestamptz
        WHERE tenant_id = $4::uuid AND id = $5::uuid`,
      [approval.rows[0].id, actorUid, decidedAt, tenantId, policyId],
    );
    await client.query(
      `UPDATE clinical_continuity_policy_versions SET lifecycle_state = 'active'
        WHERE tenant_id = $1::uuid AND id = $2::uuid`,
      [tenantId, policyId],
    );
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(facilityId)]);
    const contact = await client.query(
      `SELECT * FROM clinical_continuity_create_incident_contact_sheet(
         $1::uuid, $2::integer, $3::uuid, 'MEDICAL_SUPERINTENDENT', $4::jsonb
       )`,
      [
        tenantId,
        facilityId,
        actorUid,
        JSON.stringify({
          schemaVersion: 1,
          source: 'C-D10 raw-PG test authority',
          custodyLocation: 'Test cabinet A',
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
        }),
      ],
    );
    contactSheet = contact.rows[0];
    const contactTimes = await client.query(
      `SELECT effective_from::text, effective_until::text
         FROM clinical_continuity_incident_contact_sheets
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid`,
      [tenantId, facilityId, contactSheet.id],
    );
    contactSheet.effective_from_text = contactTimes.rows[0].effective_from;
    contactSheet.effective_until_text = contactTimes.rows[0].effective_until;
    await client.query(
      `SELECT * FROM clinical_continuity_approve_incident_contact_sheet(
         $1::uuid, $2::integer, $3::uuid, 'CMO', $4::uuid
       )`,
      [tenantId, facilityId, approverUid, contactSheet.id],
    );
    const allocated = await client.query(
      `SELECT * FROM clinical_continuity_allocate_incident_packet(
         $1::uuid, $2::integer, $3::uuid, 'MEDICAL_SUPERINTENDENT',
         $4::uuid, $5::text, $6::uuid, $7::uuid
       )`,
      [
        tenantId,
        facilityId,
        actorUid,
        requestId,
        requestFingerprint,
        reservedIncidentId,
        contactSheet.id,
      ],
    );
    allocation = allocated.rows[0];
  });

  afterAll(async () => {
    await client.query('RESET ROLE').catch(() => {});
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  afterEach(async () => {
    await client.query('RESET ROLE').catch(() => {});
  });

  function forgedIssueEvidence() {
    const validFrom = new Date(Date.now() - 1000);
    const validUntil = new Date(validFrom.getTime() + 720 * 60 * 1000);
    const forgedPacketId = randomUUID();
    const canonicalPayload = {
      allowedCopyCount: 2,
      contactSheet: {
        checksum: contactSheet.content_hash,
        effectiveFrom: contactSheet.effective_from_text,
        effectiveUntil: contactSheet.effective_until_text,
        id: contactSheet.id,
        version: String(contactSheet.version),
      },
      facilityId,
      facilityTimezone: 'Asia/Kolkata',
      format: 'vhhealth_clinical_continuity_incident_packet/v1',
      key: {
        id: packetKeyId,
        publicKeySha256: sha256(Buffer.from(packetPublicKey, 'utf8')),
        version: packetKeyVersion,
      },
      notValidAfter: validUntil.toISOString(),
      notValidBefore: validFrom.toISOString(),
      packetId: forgedPacketId,
      policy: { checksum: policyChecksum, id: policyId, version: '1' },
      purpose: 'vhhealth/continuity/incident-packet/v1',
      range: {
        first: String(allocation.range_first),
        last: String(allocation.range_last),
        prefix: allocation.range_prefix,
      },
      reservedIncidentId,
      tenantId,
    };
    const canonicalPayloadJcs = canonicalizeJson(canonicalPayload);
    const artifact = Buffer.from('FORGED INCIDENT PACKET ARTIFACT', 'utf8');
    return {
      allocation_id: allocation.id,
      artifact_base64: artifact.toString('base64'),
      artifact_sha256: sha256(artifact),
      authorization_audit_id: randomUUID(),
      canonical_payload: canonicalPayload,
      canonical_payload_hash: sha256(Buffer.from(canonicalPayloadJcs, 'utf8')),
      canonical_payload_jcs: canonicalPayloadJcs,
      packet_id: forgedPacketId,
      request_fingerprint: requestFingerprint,
      signature: `${'A'.repeat(86)}==`,
      supersedes_packet_id: null,
      valid_from: validFrom.toISOString(),
      valid_until: validUntil.toISOString(),
    };
  }

  async function authorizeIssueEvidence(evidence) {
    const authorizationAuditId = randomUUID();
    evidence.authorization_audit_id = authorizationAuditId;
    await client.query(
      `INSERT INTO clinical_audit_events (
         id, tenant_id, action, action_status, actor_uid, actor_role,
         resource_type, resource_table, resource_id, request_id, after_state
       ) VALUES (
         $1::uuid, $2::uuid, 'clinical_continuity.incident_packet.issue_authorized',
         'success', $3::uuid, 'MEDICAL_SUPERINTENDENT',
         'clinical_continuity_incident_packet_allocation',
         'clinical_continuity_incident_packet_allocations', $4::text, $5::text,
         $6::jsonb
       )`,
      [
        authorizationAuditId,
        tenantId,
        actorUid,
        allocation.id,
        requestId,
        JSON.stringify({
          artifact_sha256: evidence.artifact_sha256,
          canonical_payload_hash: evidence.canonical_payload_hash,
          packet_id: evidence.packet_id,
          signature_sha256: sha256(Buffer.from(evidence.signature, 'utf8')),
        }),
      ],
    );
  }

  test('denies direct packet INSERT, UPDATE, DELETE, and TRUNCATE to a runtime-like role', async () => {
    await client.query(`SET LOCAL ROLE ${RAW_ROLE}`);
    for (const sql of [
      `INSERT INTO clinical_continuity_incident_packets (
         id, tenant_id, facility_id, reserved_incident_id, range_prefix, range_first,
         range_last, packet_key_id, packet_key_version, canonical_payload_hash,
         signature, valid_from, valid_until, contact_sheet_version
       ) VALUES (
         '${packetId}'::uuid, '${tenantId}'::uuid, 1, '${randomUUID()}'::uuid,
         'FORGED-', 1, 10, 'forged', '1', '${'a'.repeat(64)}', 'forged', NOW(),
         NOW() + INTERVAL '1 hour', 'forged'
       )`,
      `UPDATE clinical_continuity_incident_packets SET signature = 'forged' WHERE id = '${packetId}'::uuid`,
      `DELETE FROM clinical_continuity_incident_packets WHERE id = '${packetId}'::uuid`,
      'TRUNCATE clinical_continuity_incident_packets',
    ]) {
      const failure = await capturedFailure(client, () => client.query(sql));
      expect(failure.code).toBe('42501');
    }
    await client.query('RESET ROLE');
  });

  test('denies raw audit forgery and guarded issue with a forged signature', async () => {
    await client.query(`SET LOCAL ROLE ${RAW_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(facilityId)]);
    const auditFailure = await capturedFailure(client, () => client.query(
      `INSERT INTO clinical_audit_events (tenant_id, action)
       VALUES ($1::uuid, 'clinical_continuity.incident_packet.issue_authorized')`,
      [tenantId],
    ));
    expect(auditFailure.code).toBe('42501');
    const issueFailure = await capturedFailure(client, () => client.query(
      `SELECT clinical_continuity_issue_incident_packet(
         $1::uuid, $2::integer, $3::uuid, 'MEDICAL_SUPERINTENDENT', $4::jsonb
       )`,
      [tenantId, facilityId, actorUid, JSON.stringify(forgedIssueEvidence())],
    ));
    expect(issueFailure).toMatchObject({
      code: '23514',
      constraint: 'chk_cc_packet_issue_evidence',
    });
    await client.query('RESET ROLE');
    const packetCount = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM clinical_continuity_incident_packets
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer`,
      [tenantId, facilityId],
    );
    expect(packetCount.rows[0].count).toBe(0);
  });

  test('rejects signature bytes changed after locally-verified authorization evidence', async () => {
    const evidence = forgedIssueEvidence();
    await authorizeIssueEvidence(evidence);
    evidence.signature = `${'B'.repeat(86)}==`;
    await client.query(`SET LOCAL ROLE ${RAW_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(facilityId)]);
    const failure = await capturedFailure(client, () => client.query(
      `SELECT clinical_continuity_issue_incident_packet(
         $1::uuid, $2::integer, $3::uuid, 'MEDICAL_SUPERINTENDENT', $4::jsonb
       )`,
      [tenantId, facilityId, actorUid, JSON.stringify(evidence)],
    ));
    expect(failure).toMatchObject({
      code: '23514',
      constraint: 'chk_cc_packet_issue_evidence',
    });
    await client.query('RESET ROLE');
    const packetCount = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM clinical_continuity_incident_packets
        WHERE tenant_id = $1::uuid AND facility_id = $2::integer`,
      [tenantId, facilityId],
    );
    expect(packetCount.rows[0].count).toBe(0);
  });

  test('allows the first production INSERT only with signed audit-bound evidence', async () => {
    const evidence = forgedIssueEvidence();
    evidence.signature = cryptoSign(
      null,
      Buffer.from(evidence.canonical_payload_jcs, 'utf8'),
      packetKeys.privateKey,
    ).toString('base64');
    await authorizeIssueEvidence(evidence);


    await client.query(`SET LOCAL ROLE ${RAW_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(facilityId)]);
    const issued = await client.query(
      `SELECT * FROM clinical_continuity_issue_incident_packet(
         $1::uuid, $2::integer, $3::uuid, 'MEDICAL_SUPERINTENDENT', $4::jsonb
       )`,
      [tenantId, facilityId, actorUid, JSON.stringify(evidence)],
    );
    expect(issued.rows[0]).toMatchObject({
      id: evidence.packet_id,
      packet_schema_version: 1,
      status: 'unused',
    });
    await client.query('RESET ROLE');

    const trustRoot = await client.query(
      `SELECT
         (SELECT COUNT(*)::integer
            FROM clinical_continuity_incident_packet_artifacts
           WHERE tenant_id = $1::uuid AND facility_id = $2::integer
             AND packet_id = $3::uuid) AS artifact_count,
         (SELECT COUNT(*)::integer
            FROM clinical_continuity_incident_packet_custody_events
           WHERE tenant_id = $1::uuid AND facility_id = $2::integer
             AND packet_id = $3::uuid AND event_type = 'generated') AS generated_count`,
      [tenantId, facilityId, evidence.packet_id],
    );
    expect(trustRoot.rows[0]).toEqual({ artifact_count: 1, generated_count: 1 });
  });

  test('rejects overlapping paper ranges and reserved incident UUID reuse', async () => {
    const insertAllocation = ({ incidentId, rangeFirst, rangeLast }) => client.query(
      `INSERT INTO clinical_continuity_incident_packet_allocations (
         tenant_id, facility_id, request_id, request_fingerprint, reserved_incident_id,
         range_prefix, range_first, range_last, policy_id, policy_version,
         contact_sheet_id, created_by, created_by_role
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::char(64), $5::uuid,
         $6::text, $7::bigint, $8::bigint, $9::uuid, 1,
         $10::uuid, $11::uuid, 'MEDICAL_SUPERINTENDENT'
       )`,
      [
        tenantId,
        facilityId,
        randomUUID(),
        sha256(Buffer.from(randomUUID(), 'utf8')),
        incidentId,
        allocation.range_prefix,
        rangeFirst,
        rangeLast,
        policyId,
        contactSheet.id,
        actorUid,
      ],
    );
    const overlapFailure = await capturedFailure(client, () => insertAllocation({
      incidentId: randomUUID(),
      rangeFirst: allocation.range_first,
      rangeLast: allocation.range_last,
    }));
    expect(overlapFailure).toMatchObject({
      code: '23P01',
      constraint: 'ex_cc_packet_allocation_range',
    });
    const reuseFailure = await capturedFailure(client, () => insertAllocation({
      incidentId: reservedIncidentId,
      rangeFirst: String(BigInt(allocation.range_last) + 1n),
      rangeLast: String(BigInt(allocation.range_last) + 100n),
    }));
    expect(reuseFailure).toMatchObject({
      code: '23505',
      constraint: 'uq_cc_packet_allocation_incident',
    });
  });

  test.each([
    ['unset', null, 1],
    ['empty', '', 1],
    ['bypass', 'bypass', 1],
    ['wrong tenant', randomUUID(), 1],
    ['wrong facility', tenantId, 2],
  ])('rejects %s scope before packet evidence is evaluated', async (_label, tenantScope, facilityScope) => {
    await client.query(`SET LOCAL ROLE ${RAW_ROLE}`);
    if (tenantScope === null) {
      await client.query("SELECT set_config('app.current_tenant_id', '', true)");
    } else {
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantScope]);
    }
    await client.query("SELECT set_config('app.current_facility_id', $1, true)", [String(facilityScope)]);
    const failure = await capturedFailure(client, () => client.query(
      `SELECT clinical_continuity_issue_incident_packet(
         $1::uuid, 1, $2::uuid, 'MEDICAL_SUPERINTENDENT', '{}'::jsonb
       )`,
      [tenantId, actorUid],
    ));
    expect(failure.code).toBe('42501');
    await client.query('RESET ROLE');
  });

  test('fails closed without an exact active signed schema-v4 authority', async () => {
    await client.query(`SET LOCAL ROLE ${RAW_ROLE}`);
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.current_facility_id', '1', true)");
    const failure = await capturedFailure(client, () => client.query(
      `SELECT clinical_continuity_issue_incident_packet(
         $1::uuid, 1, $2::uuid, 'MEDICAL_SUPERINTENDENT', '{}'::jsonb
       )`,
      [tenantId, actorUid],
    ));
    expect(failure.code).toBe('23514');
    expect(failure.constraint).toBe('chk_cc_packet_active_policy');
    await client.query('RESET ROLE');
  });
});
