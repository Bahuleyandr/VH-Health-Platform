import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;

const migrationSql = readFileSync(
  new URL(
    '../../migrations/632_clinical_continuity_activation_transition_governance.sql',
    import.meta.url
  ),
  'utf8'
);

describe('migration 632 C6.3-TG static authority', () => {
  test('owns the fresh slot while preserving permanently vacant 626', () => {
    const migrations = readdirSync(new URL('../../migrations/', import.meta.url));
    expect(migrations.filter(name => name.startsWith('632_'))).toEqual([
      '632_clinical_continuity_activation_transition_governance.sql'
    ]);
    expect(migrations.some(name => name.startsWith('626_'))).toBe(false);
  });

  test('ships empty and pins the conjunctive C-D11 evidence floor', () => {
    expect(migrationSql).not.toMatch(
      /INSERT INTO public\.clinical_continuity_activation_key_roster/i
    );
    expect(migrationSql).not.toMatch(
      /INSERT INTO public\.clinical_continuity_activation_evidence_gate_configs/i
    );
    expect(migrationSql).toContain('minimum_shadow_days >= 14');
    expect(migrationSql).toContain('minimum_clean_drill_records >= 1');
    expect(migrationSql).toContain('minimum shadow duration is not satisfied');
    expect(migrationSql).toContain('minimum clean drill count is not satisfied');
    expect(migrationSql).toContain('clean drill evidence records must be distinct');
    expect(migrationSql).toContain(
      'evidence-gate versions must form one non-weakening exact policy chain'
    );
  });

  test('uses full section 6.8 posture and narrow runtime commands', () => {
    for (const table of [
      'clinical_continuity_activation_key_roster',
      'clinical_continuity_activation_evidence_gate_configs',
      'clinical_continuity_activation_transition_events'
    ]) {
      expect(migrationSql).toContain(`ALTER TABLE public.${table}\n  FORCE ROW LEVEL SECURITY`);
    }
    expect(migrationSql).toContain('AS RESTRICTIVE');
    expect(migrationSql).toContain('REFERENCES public.facilities(tenant_id, id)');
    expect(migrationSql).toContain('chk_cc_activation_append_only');
    expect(migrationSql).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE');
    expect(migrationSql).toContain('clinical_continuity_activation_advance_countersign(JSONB)');
    expect(migrationSql).toContain('clinical_continuity_activation_halt(JSONB)');
    expect(migrationSql).toContain("lifecycle_state = 'retired'");
    expect(migrationSql).toContain('effective_until <= public.clinical_continuity_parse_timestamp');
    expect(migrationSql).toContain('target.policy_schema_version NOT IN (3, 4)');
  });

  test('makes advance harder than halt and binds every applied event to audit plus CAS', () => {
    expect(migrationSql).toContain('advance requires two distinct authenticated identities');
    expect(migrationSql).toContain('advance counterkey must be the complementary roster authority');
    expect(migrationSql).toContain('advance counterkey must countersign the exact intent reason');
    expect(migrationSql).toContain('advance target must directly supersede the current policy');
    expect(migrationSql).toContain(
      "roster.authority_kind NOT IN ('rollback_signoff', 'affected_unit_clinical_lead')"
    );
    expect(migrationSql).toContain("outcome = 'applied' AND clinical_audit_event_id IS NOT NULL");
    expect(migrationSql).toContain(
      "prior_state ->> 'state_fingerprint' IS DISTINCT FROM p_command ->> 'expected_state_fingerprint'"
    );
    expect(migrationSql).toContain(
      'policy activation transition requires an applied C6.3-TG command'
    );
    expect(migrationSql).toContain('activation command evidence references are invalid or duplicated');
    expect(migrationSql).toContain('activation halt command evidence is invalid');
  });
});

function token() {
  return randomUUID().replaceAll('-', '');
}

function publicKeyPem(keyId) {
  return [
    '-----BEGIN PUBLIC KEY-----',
    Buffer.from(keyId, 'utf8').toString('base64'),
    '-----END PUBLIC KEY-----'
  ].join('\n');
}

function publicKeySha256(keyId) {
  return createHash('sha256').update(publicKeyPem(keyId), 'utf8').digest('hex');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function setTenant(client, tenantId) {
  await client.query("SELECT set_config('app.current_tenant_id', $1::text, true)", [tenantId]);
}

async function capturedFailure(client, operation) {
  await client.query('SAVEPOINT expected_c63_tg_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_c63_tg_failure');
  await client.query('RELEASE SAVEPOINT expected_c63_tg_failure');
  expect(failure).toBeDefined();
  return failure;
}

async function seedUser(client, tenantId, role, label) {
  const uid = randomUUID();
  await client.query(
    `INSERT INTO users (
       uid, tenant_id, phone, name, role, is_active, status,
       is_deleted, registered_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::text, $4::text, $5::text,
       TRUE, 'active', FALSE, NOW(), NOW()
     )`,
    [uid, tenantId, `+919${token().slice(0, 9)}`, `C6.3-TG ${label}`, role]
  );
  return uid;
}

async function seedPolicy(client, fixture, values = {}) {
  const effectiveFrom = new Date(Date.now() - 60 * 60 * 1000);
  const effectiveUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const policyKeyId = `c63-policy-${token()}`.slice(0, 64);
  const packKeyId = `c63-pack-${token()}`.slice(0, 64);
  for (const [keyId, purpose] of [
    [policyKeyId, 'clinical_continuity_policy_signing'],
    [packKeyId, 'clinical_continuity_pack_signing']
  ]) {
    await client.query(
      `INSERT INTO encryption_keys (
         tenant_id, key_id, provider, algorithm, status, metadata
       ) VALUES (
         $1::uuid, $2::text, 'env', 'ed25519', 'active',
         jsonb_build_object(
           'purpose', $3::text,
           'public_key_spki_pem', $4::text
         )
       )`,
      [fixture.tenantId, keyId, purpose, publicKeyPem(keyId)]
    );
  }

  const registryChecksum = values.registryChecksum || 'a'.repeat(64);
  const registryVersion = values.registryVersion || 1;
  const policyChecksum = values.policyChecksum || 'd'.repeat(64);
  const policyVersion = values.policyVersion || 1;
  const policyDocument = {
    actionRegistry: {
      actions: Array.from({ length: 17 }, (_, index) => ({ actionId: `test.${index}` })),
      activation: {
        enforcedActionIds: values.enforcedActionIds || [],
        mode: values.mode || 'shadow'
      },
      approvalEvidence: {
        countersignedAt: '2026-07-30',
        decisionId: 'C-D3',
        source: 'docs/continuity/c0-4-owner-decision-dossier.md#c-d3--offline-action-matrix'
      },
      audience: { devicePostures: ['desktop'] },
      compatibilityRules: [],
      expiresAt: effectiveUntil.toISOString(),
      issuedAt: effectiveFrom.toISOString(),
      minimumAppVersions: { desktop: '1.0.0', tablet: '1.0.0' },
      registryChecksum,
      registrySchemaVersion: 1,
      registryVersion: String(registryVersion)
    },
    audience: {
      facilityId: String(fixture.facilityId),
      tenantId: fixture.tenantId
    },
    policySchemaVersion: 3
  };
  const policy = await client.query(
    `INSERT INTO clinical_continuity_policy_versions (
       tenant_id, facility_id, policy_version, policy_schema_version,
       action_registry_schema_version, action_registry_version,
       action_registry_checksum, policy_document, policy_checksum,
       policy_signing_key_id, policy_signing_public_key_sha256,
       current_pack_signing_key_id, current_pack_signing_public_key_sha256,
       policy_signature, effective_from, effective_until, supersedes_policy_id
     ) VALUES (
       $1::uuid, $2::integer, $3::bigint, 3, 1, $4::bigint, $5::char(64),
       $6::jsonb, $7::char(64), $8::text, $9::char(64), $10::text,
       $11::char(64), $12::bytea, $13::timestamptz, $14::timestamptz,
       $15::uuid
     ) RETURNING id::text`,
    [
      fixture.tenantId,
      fixture.facilityId,
      policyVersion,
      registryVersion,
      registryChecksum,
      JSON.stringify(policyDocument),
      policyChecksum,
      policyKeyId,
      publicKeySha256(policyKeyId),
      packKeyId,
      publicKeySha256(packKeyId),
      Buffer.alloc(64, 0x63),
      effectiveFrom,
      effectiveUntil,
      values.supersedesPolicyId || null
    ]
  );
  const policyId = policy.rows[0].id;

  const decidedAt = new Date();
  const approvedBy = [fixture.clinicalUid, fixture.technicalUid].map((uid, index) => ({
    at: new Date(decidedAt.getTime() - (index + 1) * 1000).toISOString(),
    uid
  }));
  const approval = await client.query(
    `INSERT INTO approvals (
       tenant_id, approval_kind, subject_resource_type, subject_resource_id,
       required_approvers, status, approved_by, decided_at, created_by,
       decided_by, metadata
     ) VALUES (
       $1::uuid, 'clinical_continuity_policy_governance',
       'clinical_continuity_policy_version', $2::text, 2, 'approved',
       $3::jsonb, $4::timestamptz, $5::uuid, $5::uuid, $6::jsonb
     ) RETURNING id`,
    [
      fixture.tenantId,
      policyId,
      JSON.stringify(approvedBy),
      decidedAt,
      fixture.clinicalUid,
      JSON.stringify({
        clinical_continuity_policy_governance: {
          action_registry_checksum: registryChecksum,
          action_registry_decision_id: 'C-D3',
          action_registry_schema_version: 1,
          action_registry_version: String(registryVersion),
          countersignature_complete: true,
          policy_checksum: policyChecksum
        }
      })
    ]
  );
  await client.query(
    `UPDATE clinical_continuity_policy_versions
        SET lifecycle_state = 'approved', approval_id = $1::integer,
            approved_by = $2::uuid, approved_at = $3::timestamptz
      WHERE tenant_id = $4::uuid AND id = $5::uuid`,
    [Number(approval.rows[0].id), fixture.clinicalUid, decidedAt, fixture.tenantId, policyId]
  );
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  await client.query('SET CONSTRAINTS ALL DEFERRED');
  return policyId;
}

async function insertRosterGrant(client, fixture, values) {
  const result = await client.query(
    `INSERT INTO clinical_continuity_activation_key_roster (
       tenant_id, facility_id, subject_uid, subject_role, authority_kind,
       entry_kind, signoff_role_label, affected_unit_reference, valid_from,
       owner_evidence_reference, owner_evidence_sha256, recorded_by_uid
     ) VALUES (
       $1::uuid, $2::integer, $3::uuid, $4::text, $5::text, 'grant',
       $6::text, $7::text, NOW() - INTERVAL '1 minute',
       'docs/continuity/c0-4-owner-decision-dossier.md#c-d11',
       $8::char(64), $9::uuid
     ) RETURNING id::text`,
    [
      fixture.tenantId,
      fixture.facilityId,
      values.subjectUid,
      values.subjectRole,
      values.authorityKind,
      values.signoffRoleLabel || null,
      values.affectedUnitReference || null,
      sha256(`${values.subjectUid}:${values.authorityKind}`),
      fixture.clinicalUid
    ]
  );
  return result.rows[0].id;
}

async function insertAudit(client, fixture, values) {
  const auditId = randomUUID();
  await client.query(
    `INSERT INTO clinical_audit_events (
       id, tenant_id, action, action_status, actor_uid, actor_role,
       resource_type, resource_table, resource_id, after_state
     ) VALUES (
       $1::uuid, $2::uuid, $3::text, 'success', $4::uuid, $5::text,
       'clinical_continuity_activation_transition_event',
       'clinical_continuity_activation_transition_events', $6::text, $7::jsonb
     )`,
    [
      auditId,
      fixture.tenantId,
      values.action,
      values.actorUid,
      values.actorRole,
      values.eventId,
      JSON.stringify(values.afterState)
    ]
  );
  return auditId;
}

async function callJsonCommand(client, functionName, command) {
  const result = await client.query(`SELECT public.${functionName}($1::jsonb) AS receipt`, [
    JSON.stringify(command)
  ]);
  return result.rows[0].receipt;
}

describeIfDb('migration 632 C6.3-TG database transition contract', () => {
  let client;
  let fixture;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    fixture = {
      facilityId: null,
      tenantId: randomUUID()
    };
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'C6.3-TG transition contract')`,
      [fixture.tenantId, `c63-tg-${token()}`.slice(0, 60)]
    );
    const facility = await client.query(
      `INSERT INTO facilities (tenant_id, facility_code, display_name, timezone)
       VALUES ($1::uuid, $2::text, 'C6.3-TG facility', 'Asia/Kolkata')
       RETURNING id`,
      [fixture.tenantId, `C63-${token()}`.slice(0, 70)]
    );
    fixture.facilityId = Number(facility.rows[0].id);
    await setTenant(client, fixture.tenantId);
    fixture.clinicalUid = await seedUser(client, fixture.tenantId, 'DOCTOR', 'clinical key');
    fixture.technicalUid = await seedUser(client, fixture.tenantId, 'ADMIN', 'technical key');
    fixture.haltUid = await seedUser(client, fixture.tenantId, 'DOCTOR', 'unit lead halt');
    fixture.policyId = await seedPolicy(client, fixture);
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('fails closed, requires two distinct keys, records audit-bound CAS, then accepts one-key halt', async () => {
    const initial = await client.query(
      `SELECT public.clinical_continuity_activation_state_snapshot(
         $1::uuid, $2::integer
       ) AS state`,
      [fixture.tenantId, fixture.facilityId]
    );
    expect(initial.rows[0].state).toMatchObject({
      state: 'off',
      policy_id: null
    });
    fixture.initialFingerprint = initial.rows[0].state.state_fingerprint;

    const emptyRosterFailure = await capturedFailure(client, () =>
      callJsonCommand(client, 'clinical_continuity_activation_advance_intent', {
        actor_role: 'DOCTOR',
        actor_uid: fixture.clinicalUid,
        event_id: randomUUID(),
        evidence_references: [{ reference: 'owner:test', sha256: 'e'.repeat(64) }],
        expected_state_fingerprint: fixture.initialFingerprint,
        facility_id: fixture.facilityId,
        idempotency_key_sha256: sha256(randomUUID()),
        reason_code: 'enter_shadow',
        reason_detail: 'Enter governed shadow operation.',
        roster_entry_id: randomUUID(),
        target_policy_id: fixture.policyId,
        tenant_id: fixture.tenantId
      })
    );
    expect(emptyRosterFailure).toMatchObject({
      code: '42501',
      message: expect.stringContaining('active activation roster authority required')
    });

    const directActivationFailure = await capturedFailure(client, () =>
      client.query(
        `UPDATE clinical_continuity_policy_versions SET lifecycle_state = 'active'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [fixture.tenantId, fixture.policyId]
      )
    );
    expect(directActivationFailure.message).toContain(
      'policy activation transition requires an applied C6.3-TG command'
    );

    fixture.clinicalRosterId = await insertRosterGrant(client, fixture, {
      authorityKind: 'advance_clinical',
      subjectRole: 'DOCTOR',
      subjectUid: fixture.clinicalUid
    });
    fixture.technicalRosterId = await insertRosterGrant(client, fixture, {
      authorityKind: 'advance_technical',
      subjectRole: 'ADMIN',
      subjectUid: fixture.technicalUid
    });
    fixture.haltRosterId = await insertRosterGrant(client, fixture, {
      affectedUnitReference: 'facility:affected-unit',
      authorityKind: 'affected_unit_clinical_lead',
      subjectRole: 'DOCTOR',
      subjectUid: fixture.haltUid
    });

    const intentEventId = randomUUID();
    const intentIdempotencySha256 = sha256(`intent:${intentEventId}`);
    const intent = await callJsonCommand(client, 'clinical_continuity_activation_advance_intent', {
      actor_role: 'DOCTOR',
      actor_uid: fixture.clinicalUid,
      event_id: intentEventId,
      evidence_references: [{ reference: 'owner:test', sha256: 'e'.repeat(64) }],
      expected_state_fingerprint: fixture.initialFingerprint,
      facility_id: fixture.facilityId,
      idempotency_key_sha256: intentIdempotencySha256,
      reason_code: 'enter_shadow',
      reason_detail: 'Enter governed shadow operation.',
      roster_entry_id: fixture.clinicalRosterId,
      target_policy_id: fixture.policyId,
      tenant_id: fixture.tenantId
    });
    expect(intent).toMatchObject({
      disposition: 'awaiting_counterkey',
      first_key_authority: 'advance_clinical',
      required_counterkey_authority: 'advance_technical',
      transition_kind: 'off_to_shadow'
    });

    const idempotencyDriftFailure = await capturedFailure(client, () =>
      callJsonCommand(client, 'clinical_continuity_activation_advance_intent', {
        actor_role: 'DOCTOR',
        actor_uid: fixture.clinicalUid,
        event_id: intentEventId,
        evidence_references: [{ reference: 'owner:test', sha256: 'e'.repeat(64) }],
        expected_state_fingerprint: fixture.initialFingerprint,
        facility_id: fixture.facilityId,
        idempotency_key_sha256: intentIdempotencySha256,
        reason_code: 'enter_shadow',
        reason_detail: 'A changed reason must not reuse the prior command receipt.',
        roster_entry_id: fixture.clinicalRosterId,
        target_policy_id: fixture.policyId,
        tenant_id: fixture.tenantId
      })
    );
    expect(idempotencyDriftFailure).toMatchObject({
      code: '23505',
      message: expect.stringContaining('activation intent idempotency identity drift')
    });

    const sameIdentityFailure = await capturedFailure(client, () =>
      callJsonCommand(client, 'clinical_continuity_activation_advance_countersign', {
        actor_role: 'DOCTOR',
        actor_uid: fixture.clinicalUid,
        audit_event_id: randomUUID(),
        event_id: randomUUID(),
        expected_state_fingerprint: fixture.initialFingerprint,
        facility_id: fixture.facilityId,
        idempotency_key_sha256: sha256(randomUUID()),
        intent_event_id: intentEventId,
        reason_code: 'enter_shadow',
        reason_detail: 'Enter governed shadow operation.',
        roster_entry_id: fixture.clinicalRosterId,
        tenant_id: fixture.tenantId
      })
    );
    expect(sameIdentityFailure.message).toContain(
      'advance requires two distinct authenticated identities'
    );

    const changedIntentFailure = await capturedFailure(client, () =>
      callJsonCommand(client, 'clinical_continuity_activation_advance_countersign', {
        actor_role: 'ADMIN',
        actor_uid: fixture.technicalUid,
        audit_event_id: randomUUID(),
        event_id: randomUUID(),
        expected_state_fingerprint: fixture.initialFingerprint,
        facility_id: fixture.facilityId,
        idempotency_key_sha256: sha256(randomUUID()),
        intent_event_id: intentEventId,
        reason_code: 'enter_shadow',
        reason_detail: 'A different reason detail must not be countersigned.',
        roster_entry_id: fixture.technicalRosterId,
        tenant_id: fixture.tenantId
      })
    );
    expect(changedIntentFailure.message).toContain(
      'advance counterkey must countersign the exact intent reason'
    );

    const advanceEventId = randomUUID();
    const advanceAuditId = await insertAudit(client, fixture, {
      action: 'clinical_continuity.activation.advance_applied',
      actorRole: 'ADMIN',
      actorUid: fixture.technicalUid,
      afterState: {
        event_id: advanceEventId,
        expected_state_fingerprint: fixture.initialFingerprint,
        intent_event_id: intentEventId
      },
      eventId: advanceEventId
    });
    const applied = await callJsonCommand(
      client,
      'clinical_continuity_activation_advance_countersign',
      {
        actor_role: 'ADMIN',
        actor_uid: fixture.technicalUid,
        audit_event_id: advanceAuditId,
        event_id: advanceEventId,
        expected_state_fingerprint: fixture.initialFingerprint,
        facility_id: fixture.facilityId,
        idempotency_key_sha256: sha256(`advance:${advanceEventId}`),
        intent_event_id: intentEventId,
        reason_code: 'enter_shadow',
        reason_detail: 'Enter governed shadow operation.',
        roster_entry_id: fixture.technicalRosterId,
        tenant_id: fixture.tenantId
      }
    );
    expect(applied).toMatchObject({
      clinical_key_uid: fixture.clinicalUid,
      disposition: 'applied',
      technical_key_uid: fixture.technicalUid,
      transition_kind: 'off_to_shadow'
    });

    const shadowState = await client.query(
      `SELECT public.clinical_continuity_activation_state_snapshot(
         $1::uuid, $2::integer
       ) AS state`,
      [fixture.tenantId, fixture.facilityId]
    );
    expect(shadowState.rows[0].state).toMatchObject({
      mode: 'shadow',
      policy_id: fixture.policyId,
      state: 'shadow'
    });

    const enforcePolicyId = await seedPolicy(client, fixture, {
      enforcedActionIds: ['test.0'],
      mode: 'enforce',
      policyChecksum: 'e'.repeat(64),
      policyVersion: 2,
      registryChecksum: 'b'.repeat(64),
      registryVersion: 2,
      supersedesPolicyId: fixture.policyId
    });
    const cleanDrillRecords = [
      {
        captured_work_reconciled: true,
        clean: true,
        completed_at: new Date().toISOString(),
        continuity_packs_verified: true,
        paper_path_exercised: true,
        planned: true,
        reference: 'drill:c63-tg-test',
        sha256: 'c'.repeat(64),
        unresolved_count: 0
      }
    ];
    const duplicateDrillFailure = await capturedFailure(client, () =>
      client.query(
        `INSERT INTO clinical_continuity_activation_evidence_gate_configs (
           tenant_id, facility_id, shadow_policy_id, target_policy_id,
           config_version, minimum_shadow_days, minimum_clean_drill_records,
           clean_drill_records, owner_evidence_reference, owner_evidence_sha256,
           recorded_by_uid
         ) VALUES (
           $1::uuid, $2::integer, $3::uuid, $4::uuid, 1, 14, 2, $5::jsonb,
           'docs/continuity/c0-4-owner-decision-dossier.md#c-d11',
           $6::char(64), $7::uuid
         )`,
        [
          fixture.tenantId,
          fixture.facilityId,
          fixture.policyId,
          enforcePolicyId,
          JSON.stringify([cleanDrillRecords[0], cleanDrillRecords[0]]),
          'f'.repeat(64),
          fixture.clinicalUid
        ]
      )
    );
    expect(duplicateDrillFailure.message).toContain('clean drill evidence records must be distinct');

    const gate = await client.query(
      `INSERT INTO clinical_continuity_activation_evidence_gate_configs (
         tenant_id, facility_id, shadow_policy_id, target_policy_id,
         config_version, minimum_shadow_days, minimum_clean_drill_records,
         clean_drill_records, owner_evidence_reference, owner_evidence_sha256,
         recorded_by_uid
       ) VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::uuid, 1, 14, 1, $5::jsonb,
         'docs/continuity/c0-4-owner-decision-dossier.md#c-d11',
         $6::char(64), $7::uuid
       ) RETURNING id::text`,
      [
        fixture.tenantId,
        fixture.facilityId,
        fixture.policyId,
        enforcePolicyId,
        JSON.stringify(cleanDrillRecords),
        'f'.repeat(64),
        fixture.clinicalUid
      ]
    );
    const forkedGateFailure = await capturedFailure(client, () =>
      client.query(
        `INSERT INTO clinical_continuity_activation_evidence_gate_configs (
           tenant_id, facility_id, shadow_policy_id, target_policy_id,
           config_version, minimum_shadow_days, minimum_clean_drill_records,
           clean_drill_records, owner_evidence_reference, owner_evidence_sha256,
           recorded_by_uid
         ) VALUES (
           $1::uuid, $2::integer, $3::uuid, $4::uuid, 2, 21, 1, $5::jsonb,
           'docs/continuity/c0-4-owner-decision-dossier.md#c-d11',
           $6::char(64), $7::uuid
         )`,
        [
          fixture.tenantId,
          fixture.facilityId,
          fixture.policyId,
          enforcePolicyId,
          JSON.stringify(cleanDrillRecords),
          'f'.repeat(64),
          fixture.clinicalUid
        ]
      )
    );
    expect(forkedGateFailure.message).toContain(
      'evidence-gate versions must form one non-weakening exact policy chain'
    );
    const prematureEnforcementFailure = await capturedFailure(client, () =>
      callJsonCommand(client, 'clinical_continuity_activation_advance_intent', {
        actor_role: 'DOCTOR',
        actor_uid: fixture.clinicalUid,
        event_id: randomUUID(),
        evidence_gate_config_id: gate.rows[0].id,
        evidence_references: [{ reference: 'drill:c63-tg-test', sha256: 'c'.repeat(64) }],
        expected_state_fingerprint: shadowState.rows[0].state.state_fingerprint,
        facility_id: fixture.facilityId,
        idempotency_key_sha256: sha256(randomUUID()),
        reason_code: 'enforcement_evidence_satisfied',
        reason_detail: 'Attempt enforcement before the minimum shadow interval.',
        roster_entry_id: fixture.clinicalRosterId,
        target_policy_id: enforcePolicyId,
        tenant_id: fixture.tenantId
      })
    );
    expect(prematureEnforcementFailure).toMatchObject({
      code: '23514',
      message: expect.stringContaining('minimum shadow duration is not satisfied')
    });

    const appendOnlyFailure = await capturedFailure(client, () =>
      client.query(
        `UPDATE clinical_continuity_activation_transition_events
            SET reason_code = 'forged'
          WHERE tenant_id = $1::uuid AND id = $2::uuid`,
        [fixture.tenantId, advanceEventId]
      )
    );
    expect(appendOnlyFailure).toMatchObject({
      code: '23514',
      constraint: 'chk_cc_activation_append_only'
    });

    const invalidHaltEvidenceFailure = await capturedFailure(client, () =>
      callJsonCommand(client, 'clinical_continuity_activation_halt', {
        actor_role: 'DOCTOR',
        actor_uid: fixture.haltUid,
        audit_event_id: randomUUID(),
        event_id: randomUUID(),
        evidence_references: [],
        expected_state_fingerprint: shadowState.rows[0].state.state_fingerprint,
        facility_id: fixture.facilityId,
        idempotency_key_sha256: sha256(randomUUID()),
        reason_code: 'unlisted_reason',
        roster_entry_id: fixture.haltRosterId,
        tenant_id: fixture.tenantId
      })
    );
    expect(invalidHaltEvidenceFailure.message).toContain(
      'activation halt command evidence is invalid'
    );

    const haltEventId = randomUUID();
    const haltAuditId = await insertAudit(client, fixture, {
      action: 'clinical_continuity.activation.halt_applied',
      actorRole: 'DOCTOR',
      actorUid: fixture.haltUid,
      afterState: {
        event_id: haltEventId,
        expected_state_fingerprint: shadowState.rows[0].state.state_fingerprint
      },
      eventId: haltEventId
    });
    const halted = await callJsonCommand(client, 'clinical_continuity_activation_halt', {
      actor_role: 'DOCTOR',
      actor_uid: fixture.haltUid,
      audit_event_id: haltAuditId,
      event_id: haltEventId,
      evidence_references: [],
      expected_state_fingerprint: shadowState.rows[0].state.state_fingerprint,
      facility_id: fixture.facilityId,
      idempotency_key_sha256: sha256(`halt:${haltEventId}`),
      reason_code: 'clinical_lead_veto',
      roster_entry_id: fixture.haltRosterId,
      tenant_id: fixture.tenantId
    });
    expect(halted).toMatchObject({
      disposition: 'applied',
      halt_authority_kind: 'affected_unit_clinical_lead',
      transition_kind: 'shadow_to_off'
    });

    const finalState = await client.query(
      `SELECT public.clinical_continuity_activation_state_snapshot(
         $1::uuid, $2::integer
       ) AS state`,
      [fixture.tenantId, fixture.facilityId]
    );
    expect(finalState.rows[0].state).toMatchObject({
      policy_id: null,
      state: 'off'
    });
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  });
});
