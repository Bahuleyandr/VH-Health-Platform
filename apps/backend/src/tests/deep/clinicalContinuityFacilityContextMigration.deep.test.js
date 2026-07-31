import { randomUUID } from 'node:crypto';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';

async function expectConstraint(client, operation, constraint) {
  await client.query('SAVEPOINT expected_facility_context_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_facility_context_failure');
  await client.query('RELEASE SAVEPOINT expected_facility_context_failure');
  expect(failure).toMatchObject({ code: '23514', constraint });
}

async function expectDatabaseError(client, operation, expected) {
  await client.query('SAVEPOINT expected_facility_context_database_error');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query(
    'ROLLBACK TO SAVEPOINT expected_facility_context_database_error',
  );
  await client.query(
    'RELEASE SAVEPOINT expected_facility_context_database_error',
  );
  expect(failure).toBeDefined();
  if (expected.code) expect(failure.code).toBe(expected.code);
  if (expected.constraint) expect(failure.constraint).toBe(expected.constraint);
  if (expected.message) expect(failure.message).toContain(expected.message);
}

describeIfDb('migration 604 clinical continuity facility context', () => {
  const client = new Client({ connectionString: databaseUrl });
  const tenantId = randomUUID();
  const staffUid = randomUUID();
  const actorUid = randomUUID();
  const policyId = randomUUID();
  const deviceId = randomUUID();
  const policySigningKeyId = `facility-policy-${randomUUID()}`;
  const packSigningKeyId = `facility-pack-${randomUUID()}`;
  const facilityId = 2100000000 + Math.floor(Math.random() * 1000000);
  const baseGrant = {
    tenantId,
    facilityId,
    staffUid,
    actorUid,
    policyId,
    deviceId,
  };

  beforeAll(async () => {
    await client.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO tenants (id, slug, name)
       VALUES ($1::uuid, $2::text, 'Facility context deep test')`,
      [tenantId, `facility-context-${randomUUID()}`],
    );
    await client.query(
      `INSERT INTO facilities (
         id, tenant_id, facility_code, display_name, timezone
       )
       VALUES (
         $1::integer, $2::uuid, $3::text,
         'Facility context deep test', 'Asia/Kolkata'
       )`,
      [facilityId, tenantId, `CC-${randomUUID()}`],
    );
    for (const [uid, role, phone] of [
      [staffUid, 'DOCTOR', `+9191${String(facilityId).slice(-8)}`],
      [actorUid, 'ADMIN', `+9192${String(facilityId).slice(-8)}`],
    ]) {
      await client.query(
        `INSERT INTO users (
           uid, tenant_id, phone, name, role, is_active, status,
           is_deleted, registered_at, updated_at
         )
         VALUES (
           $1::uuid, $2::uuid, $3::text, 'Facility context test',
           $4::varchar, TRUE, 'active', FALSE, NOW(), NOW()
         )`,
        [uid, tenantId, phone, role],
      );
    }
    for (const [keyId, purpose] of [
      [policySigningKeyId, 'clinical_continuity_policy_signing'],
      [packSigningKeyId, 'clinical_continuity_pack_signing'],
    ]) {
      await client.query(
        `INSERT INTO encryption_keys (
           tenant_id, key_id, provider, algorithm, status, metadata
         )
         VALUES (
           $1::uuid, $2::text, 'env', 'ed25519', 'active',
           jsonb_build_object(
             'purpose', $3::text,
             'public_key_spki_pem', 'synthetic-deep-test-key'
           )
         )`,
        [tenantId, keyId, purpose],
      );
    }
    await client.query(
      `INSERT INTO clinical_continuity_policy_versions (
         id, tenant_id, facility_id, policy_version,
         policy_schema_version, policy_document, policy_checksum,
         policy_signing_key_id, policy_signing_public_key_sha256,
         current_pack_signing_key_id,
         current_pack_signing_public_key_sha256,
         policy_signature, effective_from, effective_until
       )
       VALUES (
         $1::uuid, $2::uuid, $3::integer, 1,
         2, '{}'::jsonb, $4::char(64),
         $5::text, $6::char(64),
         $7::text, $8::char(64),
         $9::bytea, NOW() - INTERVAL '1 hour',
         NOW() + INTERVAL '4 hours'
       )`,
      [
        policyId,
        tenantId,
        facilityId,
        'a'.repeat(64),
        policySigningKeyId,
        'b'.repeat(64),
        packSigningKeyId,
        'c'.repeat(64),
        Buffer.alloc(64, 1),
      ],
    );
  });

  afterAll(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });

  function insertGrant(overrides = {}) {
    const grant = {
      purpose: 'edge_read',
      subjectKind: 'staff_device',
      locationType: 'ward',
      locationIdentifier: 'ward-test',
      staffUid: baseGrant.staffUid,
      certificate: 'a'.repeat(64),
      publicKey: null,
      credentialHash: null,
      accessRevision: '900000001',
      captureRevision: null,
      deviceId: baseGrant.deviceId,
      ...overrides,
    };
    return client.query(
      `INSERT INTO clinical_continuity_edge_access_grants (
         tenant_id, facility_id, location_type, location_identifier,
         staff_uid, device_id, client_certificate_sha256,
         device_public_key_raw, device_credential_sha256,
         valid_from, valid_until, policy_version_id, policy_version,
         access_revision, capture_revision, created_by,
         grant_purpose, subject_kind
       )
       VALUES (
         $1::uuid, $2::integer, $3::varchar, $4::varchar,
         $5::uuid, $6::varchar, $7::char(64),
         $8::bytea, $9::char(64),
         NOW(), NOW() + INTERVAL '1 hour', $10::uuid, 1,
         $11::bigint, $12::bigint, $13::uuid,
         $14::varchar, $15::varchar
       )
       RETURNING id::text`,
      [
        baseGrant.tenantId,
        baseGrant.facilityId,
        grant.locationType,
        grant.locationIdentifier,
        grant.staffUid,
        grant.deviceId,
        grant.certificate,
        grant.publicKey,
        grant.credentialHash,
        baseGrant.policyId,
        grant.accessRevision,
        grant.captureRevision,
        baseGrant.actorUid,
        grant.purpose,
        grant.subjectKind,
      ],
    );
  }

  function insertRevocation(overrides = {}) {
    const revocation = {
      purpose: 'edge_read',
      accessRevision: '900000101',
      captureRevision: null,
      grantId: randomUUID(),
      ...overrides,
    };
    return client.query(
      `INSERT INTO clinical_continuity_edge_access_revocations (
         tenant_id, facility_id, grant_id, access_revision,
         capture_revision, revoked_by, reason, grant_purpose
       )
       VALUES (
         $1::uuid, $2::integer, $3::uuid, $4::bigint,
         $5::bigint, $6::uuid, 'direct SQL negative', $7::varchar
       )
       RETURNING id::text`,
      [
        baseGrant.tenantId,
        baseGrant.facilityId,
        revocation.grantId,
        revocation.accessRevision,
        revocation.captureRevision,
        baseGrant.actorUid,
        revocation.purpose,
      ],
    );
  }

  function insertReceipt(overrides = {}) {
    const receipt = {
      purpose: 'edge_read',
      grantId: randomUUID(),
      ...overrides,
    };
    return client.query(
      `INSERT INTO clinical_continuity_edge_log_receipts (
         tenant_id, facility_id, device_id, grant_id,
         client_certificate_sha256, policy_version_id, policy_version,
         access_revision, batch_id, batch_sha256, event_count,
         first_event_sequence, last_event_sequence, first_event_at,
         last_event_at, signature_sha256, imported_by, grant_purpose
       )
       VALUES (
         $1::uuid, $2::integer, $3::varchar, $4::uuid,
         $5::char(64), $6::uuid, 1,
         900000201, 'direct-sql-negative', $7::char(64), 1,
         1, 1, NOW(), NOW(), $8::char(64), $9::uuid, $10::varchar
       )
       RETURNING id::text`,
      [
        baseGrant.tenantId,
        baseGrant.facilityId,
        baseGrant.deviceId,
        receipt.grantId,
        'a'.repeat(64),
        baseGrant.policyId,
        'b'.repeat(64),
        'c'.repeat(64),
        baseGrant.actorUid,
        receipt.purpose,
      ],
    );
  }

  it('installs validated closed-purpose and purpose-shape checks', async () => {
    const result = await client.query(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conrelid =
              'clinical_continuity_edge_access_grants'::regclass
          AND conname IN (
            'cc_facility_grant_purpose_check',
            'cc_facility_grant_subject_kind_check',
            'cc_facility_grant_purpose_shape_check'
          )
        ORDER BY conname`,
    );
    expect(result.rows).toEqual([
      {
        conname: 'cc_facility_grant_purpose_check',
        convalidated: true,
      },
      {
        conname: 'cc_facility_grant_purpose_shape_check',
        convalidated: true,
      },
      {
        conname: 'cc_facility_grant_subject_kind_check',
        convalidated: true,
      },
    ]);
  });

  it.each([
    [
      'unknown purpose',
      { purpose: 'capture_other' },
      'cc_facility_grant_purpose_check',
    ],
    [
      'edge row missing a legacy mandatory location',
      { locationType: null },
      'cc_facility_grant_purpose_shape_check',
    ],
    [
      'edge row missing its access revision',
      { accessRevision: null },
      'cc_facility_grant_purpose_shape_check',
    ],
    [
      'fixed device row carrying staff authority',
      {
        purpose: 'capture_fixed_device',
        subjectKind: 'device',
        locationType: null,
        locationIdentifier: null,
        certificate: null,
        publicKey: Buffer.alloc(32, 1),
        credentialHash:
          '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
        accessRevision: null,
        captureRevision: '900000002',
      },
      'cc_facility_grant_purpose_shape_check',
    ],
    [
      'fixed device row missing a public key',
      {
        purpose: 'capture_fixed_device',
        subjectKind: 'device',
        locationType: null,
        locationIdentifier: null,
        staffUid: null,
        certificate: null,
        publicKey: null,
        credentialHash:
          '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
        accessRevision: null,
        captureRevision: '900000007',
      },
      'cc_facility_grant_purpose_shape_check',
    ],
    [
      'capture row carrying a legacy certificate',
      {
        purpose: 'capture_staff_facility',
        subjectKind: 'staff_device',
        locationType: null,
        locationIdentifier: null,
        certificate: 'a'.repeat(64),
        publicKey: Buffer.alloc(32, 1),
        credentialHash:
          '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
        accessRevision: null,
        captureRevision: '900000008',
      },
      'cc_facility_grant_purpose_shape_check',
    ],
    [
      'capture row carrying an edge access revision',
      {
        purpose: 'capture_staff_facility',
        subjectKind: 'staff_device',
        locationType: null,
        locationIdentifier: null,
        certificate: null,
        publicKey: Buffer.alloc(32, 1),
        credentialHash:
          '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
        accessRevision: '900000009',
        captureRevision: '900000010',
      },
      'cc_facility_grant_purpose_shape_check',
    ],
    [
      'capture row with a mismatched public-key hash',
      {
        purpose: 'capture_staff_facility',
        subjectKind: 'staff_device',
        locationType: null,
        locationIdentifier: null,
        certificate: null,
        publicKey: Buffer.alloc(32, 1),
        credentialHash: 'b'.repeat(64),
        accessRevision: null,
        captureRevision: '900000003',
      },
      'cc_facility_grant_purpose_shape_check',
    ],
    [
      'staff-facility row missing its staff subject',
      {
        purpose: 'capture_staff_facility',
        subjectKind: 'staff_device',
        locationType: null,
        locationIdentifier: null,
        staffUid: null,
        certificate: null,
        publicKey: Buffer.alloc(32, 1),
        credentialHash:
          '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
        accessRevision: null,
        captureRevision: '900000004',
      },
      'cc_facility_grant_purpose_shape_check',
    ],
  ])('direct SQL rejects %s', async (_label, overrides, constraint) => {
    await expectConstraint(
      client,
      () => insertGrant(overrides),
      constraint,
    );
  });

  it.each([
    [
      'an unknown revocation purpose',
      { purpose: 'capture_other' },
      'cc_facility_revocation_purpose_check',
    ],
    [
      'an edge revocation without an access revision',
      { accessRevision: null },
      'cc_facility_revocation_revision_shape_check',
    ],
    [
      'a capture revocation carrying an edge access revision',
      {
        purpose: 'capture_fixed_device',
        accessRevision: '900000102',
        captureRevision: '900000103',
      },
      'cc_facility_revocation_revision_shape_check',
    ],
    [
      'a capture revocation without a capture revision',
      {
        purpose: 'capture_staff_facility',
        accessRevision: null,
        captureRevision: null,
      },
      'cc_facility_revocation_revision_shape_check',
    ],
  ])('direct SQL rejects %s', async (_label, overrides, constraint) => {
    await expectConstraint(
      client,
      () => insertRevocation(overrides),
      constraint,
    );
  });

  it.each(['capture_fixed_device', 'capture_staff_facility'])(
    'direct SQL rejects %s rows in the edge-only receipt ledger',
    async (purpose) => {
      await expectConstraint(
        client,
        () => insertReceipt({ purpose }),
        'cc_facility_receipt_edge_only_check',
      );
    },
  );

  it('accepts all three exact row shapes before relational checks', async () => {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    const edgeGrant = await insertGrant();
    await insertGrant({
      purpose: 'capture_fixed_device',
      subjectKind: 'device',
      locationType: null,
      locationIdentifier: null,
      staffUid: null,
      certificate: null,
      publicKey: Buffer.alloc(32, 1),
      credentialHash:
        '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
      accessRevision: null,
      captureRevision: '900000005',
    });
    await insertGrant({
      purpose: 'capture_staff_facility',
      subjectKind: 'staff_device',
      locationType: null,
      locationIdentifier: null,
      certificate: null,
      publicKey: Buffer.alloc(32, 1),
      credentialHash:
        '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
      accessRevision: null,
      captureRevision: '900000006',
    });
    const result = await client.query(
      `SELECT grant_purpose, subject_kind
         FROM clinical_continuity_edge_access_grants
        WHERE tenant_id = $1::uuid
        ORDER BY grant_purpose`,
      [tenantId],
    );
    expect(result.rows).toEqual([
      {
        grant_purpose: 'capture_fixed_device',
        subject_kind: 'device',
      },
      {
        grant_purpose: 'capture_staff_facility',
        subject_kind: 'staff_device',
      },
      { grant_purpose: 'edge_read', subject_kind: 'staff_device' },
    ]);
    await client.query("SET LOCAL session_replication_role = 'origin'");

    const edgeGrantId = edgeGrant.rows[0].id;
    await expectDatabaseError(
      client,
      () => client.query(
        `UPDATE clinical_continuity_edge_access_grants
            SET location_identifier = 'owner-mutation'
          WHERE tenant_id = $1::uuid
            AND facility_id = $2::integer
            AND id = $3::uuid`,
        [tenantId, facilityId, edgeGrantId],
      ),
      { code: '55000', message: 'append-only' },
    );

    const revocation = await insertRevocation({ grantId: edgeGrantId });
    await expectDatabaseError(
      client,
      () => client.query(
        `UPDATE clinical_continuity_edge_access_revocations
            SET reason = 'owner mutation'
          WHERE tenant_id = $1::uuid
            AND facility_id = $2::integer
            AND id = $3::uuid`,
        [tenantId, facilityId, revocation.rows[0].id],
      ),
      { code: '55000', message: 'append-only' },
    );

    const receipt = await insertReceipt({ grantId: edgeGrantId });
    await expectDatabaseError(
      client,
      () => client.query(
        `UPDATE clinical_continuity_edge_log_receipts
            SET batch_id = 'owner-mutation'
          WHERE tenant_id = $1::uuid
            AND facility_id = $2::integer
            AND id = $3::uuid`,
        [tenantId, facilityId, receipt.rows[0].id],
      ),
      { code: '55000', message: 'append-only' },
    );
  });

  it('rejects overlapping unrevoked fixed-device grants', async () => {
    const overlappingDeviceId = randomUUID();
    const fixedShape = {
      purpose: 'capture_fixed_device',
      subjectKind: 'device',
      locationType: null,
      locationIdentifier: null,
      staffUid: null,
      deviceId: overlappingDeviceId,
      certificate: null,
      publicKey: Buffer.alloc(32, 1),
      credentialHash:
        '72cd6e8422c407fb6d098690f1130b7ded7ec2f7f5e1d30bd9d521f015363793',
      accessRevision: null,
    };
    await expectDatabaseError(
      client,
      async () => {
        await insertGrant({
          ...fixedShape,
          captureRevision: '900000011',
        });
        await insertGrant({
          ...fixedShape,
          captureRevision: '900000012',
        });
        await client.query(
          'SET CONSTRAINTS trg_cc_fixed_device_no_overlap IMMEDIATE',
        );
      },
      {
        code: '23514',
        message:
          'a fixed continuity device cannot have overlapping active facility grants',
      },
    );
  });

  it('tenant-scoped device identity fails closed and cannot cross tenant', async () => {
    const otherTenantId = randomUUID();
    const sharedUserUid = randomUUID();
    const sharedDeviceId = randomUUID();
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO user_devices (
         tenant_id, user_uid, device_id, device_name
       )
       VALUES
         ($1::uuid, $3::uuid, $4::varchar, 'tenant-a'),
         ($2::uuid, $3::uuid, $4::varchar, 'tenant-b')`,
      [tenantId, otherTenantId, sharedUserUid, sharedDeviceId],
    );
    await client.query("SET LOCAL session_replication_role = 'origin'");

    const role = await client.query(
      `SELECT rolname
         FROM pg_roles
        WHERE rolname = 'rls_test_app'
          AND NOT rolbypassrls`,
    );
    if (role.rowCount === 0) return;

    await client.query('SET LOCAL ROLE rls_test_app');
    try {
      for (const setting of ['', 'bypass', DEFAULT_TENANT_ID]) {
        await client.query(
          "SELECT set_config('app.current_tenant_id', $1::text, true)",
          [setting],
        );
        const hidden = await client.query(
          `SELECT tenant_id::text
             FROM user_devices
            WHERE user_uid = $1::uuid
              AND device_id = $2`,
          [sharedUserUid, sharedDeviceId],
        );
        expect(hidden.rowCount).toBe(0);
      }

      await client.query('RESET app.current_tenant_id');
      const unset = await client.query(
        `SELECT tenant_id::text
           FROM user_devices
          WHERE user_uid = $1::uuid
            AND device_id = $2`,
        [sharedUserUid, sharedDeviceId],
      );
      expect(unset.rowCount).toBe(0);

      for (const [setting, expectedName] of [
        [tenantId, 'tenant-a'],
        [otherTenantId, 'tenant-b'],
      ]) {
        await client.query(
          "SELECT set_config('app.current_tenant_id', $1::text, true)",
          [setting],
        );
        const visible = await client.query(
          `SELECT tenant_id::text, device_name
             FROM user_devices
            WHERE user_uid = $1::uuid
              AND device_id = $2`,
          [sharedUserUid, sharedDeviceId],
        );
        expect(visible.rows).toEqual([
          { tenant_id: setting, device_name: expectedName },
        ]);
      }

      await client.query(
        "SELECT set_config('app.current_tenant_id', $1::text, true)",
        [tenantId],
      );
      const crossTenantUpdate = await client.query(
        `UPDATE user_devices
            SET device_name = 'cross-tenant'
          WHERE tenant_id = $1::uuid
            AND user_uid = $2::uuid
            AND device_id = $3`,
        [otherTenantId, sharedUserUid, sharedDeviceId],
      );
      expect(crossTenantUpdate.rowCount).toBe(0);

      await client.query(
        "SELECT set_config('app.current_tenant_id', $1::text, true)",
        [otherTenantId],
      );
      const otherTenant = await client.query(
        `SELECT device_name
           FROM user_devices
          WHERE user_uid = $1::uuid
            AND device_id = $2`,
        [sharedUserUid, sharedDeviceId],
      );
      expect(otherTenant.rows).toEqual([{ device_name: 'tenant-b' }]);
    } finally {
      await client.query('RESET ROLE');
    }
  });

  it('keeps capture issuance privileges absent while C-D14 is open', async () => {
    const roles = await client.query(
      `SELECT rolname
         FROM pg_roles
        WHERE rolname IN ('vhhealth_app', 'vhhealth_runtime')
        ORDER BY rolname`,
    );
    for (const { rolname } of roles.rows) {
      const privilege = await client.query(
        `SELECT
           has_sequence_privilege(
             $1,
             'clinical_continuity_capture_revision_seq',
             'USAGE'
           ) AS capture_sequence,
           has_sequence_privilege(
             $1,
             'clinical_continuity_context_revision_seq',
             'USAGE'
           ) AS context_sequence,
           has_column_privilege(
             $1,
             'clinical_continuity_edge_access_grants',
             'capture_revision',
             'INSERT'
           ) AS capture_column`,
        [rolname],
      );
      expect(privilege.rows[0]).toEqual({
        capture_sequence: false,
        context_sequence: false,
        capture_column: false,
      });
    }
  });
});
