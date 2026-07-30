import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

import { Client } from 'pg';

const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = databaseUrl ? describe : describe.skip;
const migrationSql = readFileSync(
  new URL('../../migrations/601_clinical_continuity_edge_access.sql', import.meta.url),
  'utf8',
);

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const RLS_TEST_ROLE = 'rls_test_app';
const TABLES = [
  'clinical_continuity_edge_access_grants',
  'clinical_continuity_edge_access_revocations',
  'clinical_continuity_edge_log_receipts',
];

function token() {
  return randomUUID().replaceAll('-', '');
}

function publicKeyPem(keyId) {
  return [
    '-----BEGIN PUBLIC KEY-----',
    Buffer.from(keyId, 'utf8').toString('base64'),
    '-----END PUBLIC KEY-----',
  ].join('\n');
}

function publicKeySha256(keyId) {
  return createHash('sha256').update(publicKeyPem(keyId), 'utf8').digest('hex');
}

async function setTenant(client, tenantId) {
  await client.query(
    "SELECT set_config('app.current_tenant_id', $1::text, true)",
    [tenantId],
  );
}

async function expectFailure(client, operation, expected = {}) {
  await client.query('SAVEPOINT expected_edge_failure');
  let failure;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  await client.query('ROLLBACK TO SAVEPOINT expected_edge_failure');
  await client.query('RELEASE SAVEPOINT expected_edge_failure');
  expect(failure).toBeDefined();
  if (expected.code) expect(failure.code).toBe(expected.code);
  if (expected.message) expect(failure.message).toContain(expected.message);
  return failure;
}

async function seedTenant(client, label) {
  const tenantId = randomUUID();
  await client.query(
    `INSERT INTO tenants (id, slug, name)
     VALUES ($1::uuid, $2::text, $3::text)`,
    [tenantId, `edge-${label}-${token()}`.slice(0, 60), `Edge ${label}`],
  );
  return tenantId;
}

async function seedFacility(client, tenantId, label) {
  const result = await client.query(
    `INSERT INTO facilities
       (tenant_id, facility_code, display_name, timezone)
     VALUES ($1::uuid, $2::text, $3::text, 'Asia/Kolkata')
     RETURNING id`,
    [tenantId, `EDGE-${label}-${token()}`.slice(0, 70), `Edge facility ${label}`],
  );
  return Number(result.rows[0].id);
}

async function seedUser(client, tenantId, label) {
  const uid = randomUUID();
  await client.query(
    `INSERT INTO users
       (uid, tenant_id, phone, name, role, is_active, status,
        is_deleted, registered_at, updated_at)
     VALUES
       ($1::uuid, $2::uuid, $3::text, $4::text, 'ADMIN', TRUE, 'active',
        FALSE, NOW(), NOW())`,
    [uid, tenantId, `+918${token().slice(0, 9)}`, `Edge ${label}`],
  );
  return uid;
}

async function seedKey(client, tenantId, keyId, purpose) {
  await setTenant(client, tenantId);
  await client.query(
    `INSERT INTO encryption_keys
       (tenant_id, key_id, provider, algorithm, status, metadata)
     VALUES
       ($1::uuid, $2::text, 'env', 'ed25519', 'active',
        jsonb_build_object(
          'purpose', $3::text,
          'public_key_spki_pem', $4::text
        ))`,
    [tenantId, keyId, purpose, publicKeyPem(keyId)],
  );
}

async function seedPolicy(client, tenantId, facilityId) {
  const policyKeyId = `edge-policy-${token()}`;
  const packKeyId = `edge-pack-${token()}`;
  await seedKey(
    client,
    tenantId,
    policyKeyId,
    'clinical_continuity_policy_signing',
  );
  await seedKey(
    client,
    tenantId,
    packKeyId,
    'clinical_continuity_pack_signing',
  );
  const result = await client.query(
    `INSERT INTO clinical_continuity_policy_versions
       (tenant_id, facility_id, policy_version, policy_schema_version,
        policy_document, policy_checksum, policy_signing_key_id,
        policy_signing_public_key_sha256, current_pack_signing_key_id,
        current_pack_signing_public_key_sha256, policy_signature,
        revocation_epoch, revoked_key_ids, effective_from)
     VALUES
       ($1::uuid, $2::integer, 1, 2, $3::jsonb, $4::char(64), $5::text,
        $6::char(64), $7::text, $8::char(64), $9::bytea, 0, '[]'::jsonb,
        NOW() - INTERVAL '1 hour')
     RETURNING id::text, policy_version::text`,
    [
      tenantId,
      facilityId,
      JSON.stringify({
        audience: { tenantId, facilityId: String(facilityId) },
        edgeAccess: {
          authenticationMode: 'mtls_client_certificate',
          credentialLifetimeMinutes: 480,
          emergencyReadPosture: 'read_only',
          maximumOfflineAuthorizationMinutes: 60,
        },
        retention: {
          recoveredLogReceiptHours: 8760,
          sourcePackRetentionHours: 24,
        },
      }),
      'a'.repeat(64),
      policyKeyId,
      publicKeySha256(policyKeyId),
      packKeyId,
      publicKeySha256(packKeyId),
      Buffer.alloc(64, 0x5a),
    ],
  );
  return result.rows[0];
}

async function insertGrant(client, values) {
  return client.query(
    `INSERT INTO clinical_continuity_edge_access_grants
       (tenant_id, facility_id, location_type, location_identifier,
        staff_uid, device_id, client_certificate_sha256,
        valid_from, valid_until, policy_version_id, policy_version, created_by)
     VALUES
       ($1::uuid, $2::integer, 'ward', $3::text,
        $4::uuid, $5::text, $6::char(64),
        $7::timestamptz, $8::timestamptz, $9::uuid, $10::bigint, $11::uuid)
     RETURNING id::text, access_revision::text`,
    [
      values.tenantId,
      values.facilityId,
      values.locationIdentifier || 'ward-10',
      values.staffUid,
      values.deviceId || 'edge-device-1',
      values.certificateSha256 || 'b'.repeat(64),
      values.validFrom || new Date(Date.now() - 60 * 1000),
      values.validUntil || new Date(Date.now() + 60 * 60 * 1000),
      values.policyId,
      values.policyVersion,
      values.createdBy,
    ],
  );
}

describe('migration 601 static edge-access contract', () => {
  test('reserves one inert backend-only migration with three strict tables', () => {
    const names = readdirSync(new URL('../../migrations/', import.meta.url))
      .filter((name) => name.startsWith('601_'));
    expect(names).toEqual(['601_clinical_continuity_edge_access.sql']);
    expect(migrationSql).toContain('-- @no-transaction');
    for (const table of TABLES) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(migrationSql).toContain(`ALTER TABLE ${table}\n  FORCE ROW LEVEL SECURITY`);
    }
    expect(migrationSql).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?clinical_continuity_edge_/i,
    );
    expect(migrationSql).not.toMatch(/\bprivate[_ ]?key\b/i);
    expect(migrationSql).toContain('client_certificate_sha256');
  });

  test('makes primary keys and every explicit index tenant/facility first', () => {
    expect(
      migrationSql.match(/PRIMARY KEY \(tenant_id, facility_id, id\)/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    const indexColumns = [...migrationSql.matchAll(
      /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [\s\S]*?\n\s+ON (clinical_continuity_edge_[^(]+) \(\s*([^,\s]+),\s*([^,\s]+)/g,
    )];
    expect(indexColumns.length).toBeGreaterThan(0);
    for (const [, , first, second] of indexColumns) {
      expect([first, second]).toEqual(['tenant_id', 'facility_id']);
    }
  });

  test('pins immutable grants, independent revocations, strict RLS, and least privilege', () => {
    expect(migrationSql).toContain('clinical_continuity_edge_block_mutation');
    expect(migrationSql).toContain('Renewal creates a new grant row');
    expect(migrationSql).toContain('CREATE POLICY cc_edge_grant_explicit_context');
    expect(migrationSql).toContain('CREATE POLICY cc_edge_revocation_explicit_context');
    expect(migrationSql).toContain('CREATE POLICY cc_edge_receipt_explicit_context');
    expect(migrationSql).toContain(
      "ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]",
    );
    expect(migrationSql).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE',
    );
    const grantInsert = migrationSql.match(
      /GRANT INSERT \(\s*tenant_id, facility_id, location_type[\s\S]*?\) ON clinical_continuity_edge_access_grants/,
    )?.[0];
    const revocationInsert = migrationSql.match(
      /GRANT INSERT \(\s*tenant_id, facility_id, grant_id[\s\S]*?\) ON clinical_continuity_edge_access_revocations/,
    )?.[0];
    expect(grantInsert).not.toContain('access_revision');
    expect(revocationInsert).not.toContain('access_revision');
  });
});

describeIfDb('migration 601 database edge-access contract', () => {
  let client;
  let tenantA;
  let tenantB;
  let facilityA;
  let facilityB;
  let staffA;
  let actorA;
  let policyA;
  let firstGrant;
  let rlsRoleReady = false;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query('BEGIN');
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');

    tenantA = await seedTenant(client, 'tenant-a');
    tenantB = await seedTenant(client, 'tenant-b');
    facilityA = await seedFacility(client, tenantA, 'a');
    facilityB = await seedFacility(client, tenantB, 'b');
    staffA = await seedUser(client, tenantA, 'staff-a');
    actorA = await seedUser(client, tenantA, 'actor-a');
    policyA = await seedPolicy(client, tenantA, facilityA);

    const role = await client.query(
      `SELECT pg_has_role(current_user, $1::name, 'MEMBER') AS member,
              role.rolsuper, role.rolbypassrls
         FROM pg_roles AS role
        WHERE role.rolname = $1::name`,
      [RLS_TEST_ROLE],
    );
    rlsRoleReady = role.rows.length === 1
      && role.rows[0].member === true
      && role.rows[0].rolsuper === false
      && role.rows[0].rolbypassrls === false;
    if (rlsRoleReady) {
      await client.query(
        `GRANT SELECT, INSERT ON
           clinical_continuity_edge_access_grants,
           clinical_continuity_edge_access_revocations,
           clinical_continuity_edge_log_receipts
         TO ${RLS_TEST_ROLE}`,
      );
      await client.query(
        `GRANT USAGE, SELECT ON SEQUENCE
           clinical_continuity_edge_access_revision_seq
         TO ${RLS_TEST_ROLE}`,
      );
    }
  });

  afterAll(async () => {
    if (client) {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  test('re-applies cleanly after provisional 601 and preserves tenant-first indexes', async () => {
    await expect(client.query(migrationSql)).resolves.toBeDefined();
    const indexes = await client.query(
      `SELECT indexrelid::regclass::text AS name,
              pg_get_indexdef(indexrelid) AS definition
         FROM pg_index
        WHERE indrelid = ANY($1::regclass[])
        ORDER BY indexrelid::regclass::text`,
      [TABLES],
    );
    expect(indexes.rows.length).toBeGreaterThanOrEqual(12);
    for (const row of indexes.rows) {
      expect(row.definition).toMatch(
        /USING btree \(tenant_id, facility_id(?:,|\))/,
      );
    }
  });

  test('creates immutable renewals, independent revocations, and PHI-free receipts', async () => {
    await setTenant(client, tenantA);
    const first = await insertGrant(client, {
      tenantId: tenantA,
      facilityId: facilityA,
      staffUid: staffA,
      createdBy: actorA,
      policyId: policyA.id,
      policyVersion: policyA.policy_version,
    });
    firstGrant = first.rows[0];
    const renewal = await insertGrant(client, {
      tenantId: tenantA,
      facilityId: facilityA,
      staffUid: staffA,
      createdBy: actorA,
      policyId: policyA.id,
      policyVersion: policyA.policy_version,
      validFrom: new Date(Date.now() + 2 * 60 * 60 * 1000),
      validUntil: new Date(Date.now() + 3 * 60 * 60 * 1000),
    });
    expect(BigInt(renewal.rows[0].access_revision))
      .toBeGreaterThan(BigInt(firstGrant.access_revision));
    expect(renewal.rows[0].id).not.toBe(firstGrant.id);

    const revocation = await client.query(
      `INSERT INTO clinical_continuity_edge_access_revocations
         (tenant_id, facility_id, grant_id, revoked_by, reason)
       VALUES ($1::uuid, $2::integer, $3::uuid, $4::uuid, 'device retired')
       RETURNING id::text, access_revision::text`,
      [tenantA, facilityA, firstGrant.id, actorA],
    );
    expect(BigInt(revocation.rows[0].access_revision))
      .toBeGreaterThan(BigInt(renewal.rows[0].access_revision));

    const receipt = await client.query(
      `INSERT INTO clinical_continuity_edge_log_receipts
         (tenant_id, facility_id, device_id, grant_id,
          client_certificate_sha256, policy_version_id, policy_version,
          access_revision, batch_id, previous_batch_sha256, batch_sha256,
          event_count, first_event_sequence, last_event_sequence,
          first_event_at, last_event_at, signature_algorithm,
          signature_sha256, imported_by)
       VALUES
         ($1::uuid, $2::integer, 'edge-device-1', $3::uuid,
          $4::char(64), $5::uuid, $6::bigint,
          $7::bigint, 'batch-1', NULL, $8::char(64),
          1, 1, 1, NOW() - INTERVAL '1 minute', NOW() - INTERVAL '1 minute',
          'ed25519', $9::char(64), $10::uuid)
       RETURNING id::text`,
      [
        tenantA,
        facilityA,
        firstGrant.id,
        'b'.repeat(64),
        policyA.id,
        policyA.policy_version,
        firstGrant.access_revision,
        'c'.repeat(64),
        'd'.repeat(64),
        actorA,
      ],
    );
    expect(receipt.rows[0].id).toMatch(/^[0-9a-f-]{36}$/);

    for (const [table, id] of [
      ['clinical_continuity_edge_access_grants', firstGrant.id],
      ['clinical_continuity_edge_access_revocations', revocation.rows[0].id],
      ['clinical_continuity_edge_log_receipts', receipt.rows[0].id],
    ]) {
      await expectFailure(
        client,
        () => client.query(
          `UPDATE ${table} SET facility_id = facility_id
            WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid`,
          [tenantA, facilityA, id],
        ),
        { code: '55000', message: 'append-only' },
      );
      await expectFailure(
        client,
        () => client.query(
          `DELETE FROM ${table}
            WHERE tenant_id = $1::uuid AND facility_id = $2::integer AND id = $3::uuid`,
          [tenantA, facilityA, id],
        ),
        { code: '55000', message: 'append-only' },
      );
    }
  });

  test('rejects cross-tenant and default-tenant grant scope', async () => {
    await setTenant(client, tenantA);
    await expectFailure(
      client,
      () => insertGrant(client, {
        tenantId: tenantA,
        facilityId: facilityB,
        staffUid: staffA,
        createdBy: actorA,
        policyId: policyA.id,
        policyVersion: policyA.policy_version,
      }),
      { code: '23503' },
    );
    await expectFailure(
      client,
      () => insertGrant(client, {
        tenantId: DEFAULT_TENANT_ID,
        facilityId: facilityA,
        staffUid: staffA,
        createdBy: actorA,
        policyId: policyA.id,
        policyVersion: policyA.policy_version,
      }),
      { code: '23514' },
    );
  });

  test('fails closed for unset, bypass, and cross-tenant non-owner context', async () => {
    if (!rlsRoleReady) {
      throw new Error(
        `${RLS_TEST_ROLE} must exist as a granted NOSUPERUSER NOBYPASSRLS role`,
      );
    }
    await client.query('SAVEPOINT edge_worker_scope');
    await client.query(`SET LOCAL ROLE ${RLS_TEST_ROLE}`);

    await setTenant(client, tenantA);
    const tenantVisible = await client.query(
      `SELECT DISTINCT tenant_id::text
         FROM clinical_continuity_edge_access_grants
        ORDER BY tenant_id::text`,
    );
    expect(tenantVisible.rows).toEqual([{ tenant_id: tenantA }]);

    await setTenant(client, 'bypass');
    const bypassVisible = await client.query(
      'SELECT COUNT(*)::integer AS count FROM clinical_continuity_edge_access_grants',
    );
    expect(bypassVisible.rows[0].count).toBe(0);

    await setTenant(client, '');
    const unsetVisible = await client.query(
      'SELECT COUNT(*)::integer AS count FROM clinical_continuity_edge_access_grants',
    );
    expect(unsetVisible.rows[0].count).toBe(0);

    await setTenant(client, tenantB);
    const crossVisible = await client.query(
      `SELECT COUNT(*)::integer AS count
         FROM clinical_continuity_edge_access_grants
        WHERE tenant_id = $1::uuid`,
      [tenantA],
    );
    expect(crossVisible.rows[0].count).toBe(0);

    await client.query('ROLLBACK TO SAVEPOINT edge_worker_scope');
    await client.query('RELEASE SAVEPOINT edge_worker_scope');
  });

  test('pins least-privilege runtime column grants when production roles exist', async () => {
    const roles = await client.query(
      `SELECT rolname
         FROM pg_roles
        WHERE rolname IN ('vhhealth_app', 'vhhealth_runtime')
        ORDER BY rolname`,
    );
    if (roles.rows.length !== 2) {
      expect(migrationSql).toContain(
        "ARRAY['vhhealth_app', 'vhhealth_runtime']::TEXT[]",
      );
      return;
    }
    const privileges = await client.query(
      `SELECT
         has_table_privilege(
           'vhhealth_runtime', 'clinical_continuity_edge_access_grants', 'SELECT'
         ) AS can_select,
         has_table_privilege(
           'vhhealth_runtime', 'clinical_continuity_edge_access_grants', 'UPDATE'
         ) AS can_update,
         has_table_privilege(
           'vhhealth_runtime', 'clinical_continuity_edge_access_grants', 'DELETE'
         ) AS can_delete,
         has_column_privilege(
           'vhhealth_runtime', 'clinical_continuity_edge_access_grants',
           'tenant_id', 'INSERT'
         ) AS can_insert_tenant,
         has_column_privilege(
           'vhhealth_runtime', 'clinical_continuity_edge_access_grants',
           'access_revision', 'INSERT'
         ) AS can_insert_revision,
         has_sequence_privilege(
           'vhhealth_runtime',
           'clinical_continuity_edge_access_revision_seq', 'USAGE'
         ) AS can_use_revision_sequence,
         has_sequence_privilege(
           'vhhealth_runtime',
           'clinical_continuity_edge_access_revision_seq', 'UPDATE'
         ) AS can_update_revision_sequence`,
    );
    expect(privileges.rows[0]).toEqual({
      can_select: true,
      can_update: false,
      can_delete: false,
      can_insert_tenant: true,
      can_insert_revision: false,
      can_use_revision_sequence: true,
      can_update_revision_sequence: false,
    });
  });
});
